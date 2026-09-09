use std::{
    io::{self, BufRead, Write},
    process::Command,
    thread,
    time::{Duration, Instant},
};

use anyhow::{anyhow, bail, Context, Result};
use clap::{Args, Parser, Subcommand};
use keyring::Entry;
use reqwest::{blocking::Client, header, redirect::Policy, StatusCode};
use serde::Deserialize;
use serde_json::{json, Value};
use url::Url;

const KEYCHAIN_SERVICE: &str = "to.operate.cli";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const MCP_PROTOCOL_VERSION: &str = "2025-11-25";

#[derive(Parser)]
#[command(
    name = "operate",
    version,
    about = "Secure CLI and MCP bridge for operate.to"
)]
struct Cli {
    /// Operate server origin. HTTPS is required except for localhost development.
    #[arg(
        long,
        env = "OPERATE_API_BASE",
        default_value = "https://www.operate.to",
        global = true
    )]
    api_base: String,

    /// Use this credential for the current process instead of macOS Keychain.
    #[arg(long, env = "OPERATE_API_KEY", hide_env_values = true, global = true)]
    api_key: Option<String>,

    #[command(subcommand)]
    command: TopLevel,
}

#[derive(Subcommand)]
enum TopLevel {
    /// Sign in, inspect the active credential, or remove it.
    Auth {
        #[command(subcommand)]
        command: AuthCommand,
    },
    /// Print the server's live agent capability manifest.
    Manifest,
    /// List the MCP tools currently exposed by the server.
    Tools,
    /// Call one MCP tool with a JSON object as its arguments.
    Call(CallArgs),
    /// Show the workspace and agent attached to this credential.
    Whoami,
    /// Ask Operate for the next ready task.
    Next,
    /// Run the stdio-to-HTTPS MCP bridge for local agent runtimes.
    Mcp {
        #[command(subcommand)]
        command: McpCommand,
    },
}

#[derive(Subcommand)]
enum AuthCommand {
    /// Open a browser and wait for a human to approve this Mac.
    Login,
    /// Verify that the saved credential still works.
    Status,
    /// Delete the saved credential from macOS Keychain.
    Logout,
}

#[derive(Subcommand)]
enum McpCommand {
    /// Expose Operate over MCP's local stdio transport.
    Serve,
}

#[derive(Args)]
struct CallArgs {
    /// Tool name from `operate tools`.
    tool: String,
    /// Tool arguments as a JSON object.
    #[arg(long, default_value = "{}")]
    arguments: String,
}

#[derive(Deserialize)]
struct DeviceAuthorization {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct DeviceToken {
    api_key: String,
    agent_name: String,
    scope_name: String,
}

#[derive(Deserialize)]
struct OAuthError {
    error: String,
    error_description: Option<String>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Error: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    let origin = secure_origin(&cli.api_base)?;
    let client = http_client(origin.scheme() == "https")?;

    match cli.command {
        TopLevel::Auth { command } => match command {
            AuthCommand::Login => login(&client, &origin),
            AuthCommand::Status => {
                let key = credential(&origin, cli.api_key.as_deref())?;
                let value = call_tool(&client, &origin, &key, "whoami", json!({}))?;
                print_json(&value)
            }
            AuthCommand::Logout => logout(&origin),
        },
        TopLevel::Manifest => {
            let value = get_json(&client, origin.join("/api/agent/manifest")?)?;
            print_json(&value)
        }
        TopLevel::Tools => {
            let key = credential(&origin, cli.api_key.as_deref())?;
            let value = mcp_request(
                &client,
                &origin,
                &key,
                &json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
                true,
            )?;
            print_json(&value)
        }
        TopLevel::Call(args) => {
            let arguments: Value =
                serde_json::from_str(&args.arguments).context("--arguments must be valid JSON")?;
            if !arguments.is_object() {
                bail!("--arguments must be a JSON object");
            }
            let key = credential(&origin, cli.api_key.as_deref())?;
            let value = call_tool(&client, &origin, &key, &args.tool, arguments)?;
            print_json(&value)
        }
        TopLevel::Whoami => {
            let key = credential(&origin, cli.api_key.as_deref())?;
            print_json(&call_tool(&client, &origin, &key, "whoami", json!({}))?)
        }
        TopLevel::Next => {
            let key = credential(&origin, cli.api_key.as_deref())?;
            print_json(&call_tool(&client, &origin, &key, "next_task", json!({}))?)
        }
        TopLevel::Mcp {
            command: McpCommand::Serve,
        } => {
            let key = credential(&origin, cli.api_key.as_deref())?;
            serve_stdio(&client, &origin, &key)
        }
    }
}

fn http_client(https_only: bool) -> Result<Client> {
    Client::builder()
        .https_only(https_only)
        // Every authenticated request is built from the already-validated
        // origin. Following a redirect adds no capability and can silently
        // turn a correct origin boundary into a credential-routing surprise.
        .redirect(Policy::none())
        .timeout(Duration::from_secs(70))
        .user_agent(concat!("operate-cli/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("could not initialize the HTTPS client")
}

fn secure_origin(input: &str) -> Result<Url> {
    let mut url = Url::parse(input).context("--api-base must be an absolute URL")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        bail!("--api-base must use HTTPS (HTTP is allowed only for localhost)");
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("--api-base must be a bare origin without credentials, query, or fragment");
    }
    url.set_path("/");
    Ok(url)
}

fn keychain_entry(origin: &Url) -> Result<Entry> {
    Entry::new(KEYCHAIN_SERVICE, origin.as_str()).context("could not access macOS Keychain")
}

fn credential(origin: &Url, override_key: Option<&str>) -> Result<String> {
    if let Some(key) = override_key {
        if key.trim().is_empty() {
            bail!("OPERATE_API_KEY is empty");
        }
        return Ok(key.to_owned());
    }
    keychain_entry(origin)?.get_password().with_context(|| {
        format!(
            "not signed in to {}; run `operate auth login`",
            origin.origin().ascii_serialization()
        )
    })
}

fn logout(origin: &Url) -> Result<()> {
    let entry = keychain_entry(origin)?;
    match entry.delete_credential() {
        Ok(()) => {
            println!("Signed out of {}.", origin.origin().ascii_serialization());
            Ok(())
        }
        Err(keyring::Error::NoEntry) => {
            println!(
                "No saved credential for {}.",
                origin.origin().ascii_serialization()
            );
            Ok(())
        }
        Err(error) => Err(error).context("could not delete the credential from macOS Keychain"),
    }
}

fn login(client: &Client, origin: &Url) -> Result<()> {
    let response = client
        .post(origin.join("/oauth/device")?)
        .json(&json!({"client_name":"Operate CLI for macOS"}))
        .send()
        .context("could not start device authorization")?;
    let response = decode_success::<DeviceAuthorization>(response)?;

    println!("Open {}", response.verification_uri);
    println!("Enter code: {}", response.user_code);
    if let Err(error) = Command::new("open")
        .arg(&response.verification_uri_complete)
        .status()
    {
        eprintln!("Could not open the browser automatically: {error}");
    }

    let deadline = Instant::now() + Duration::from_secs(response.expires_in);
    let mut interval = response.interval.max(1);
    loop {
        if Instant::now() >= deadline {
            bail!("the sign-in code expired; run `operate auth login` again");
        }
        thread::sleep(Duration::from_secs(interval));
        let result = client
            .post(origin.join("/oauth/token")?)
            .form(&[
                ("grant_type", DEVICE_GRANT),
                ("device_code", &response.device_code),
            ])
            .send()
            .context("could not poll device authorization")?;

        if result.status().is_success() {
            let token: DeviceToken = result
                .json()
                .context("server returned an invalid token response")?;
            keychain_entry(origin)?
                .set_password(&token.api_key)
                .context("authorization succeeded, but macOS Keychain refused the credential")?;
            println!(
                "Signed in as {} with access to {}.",
                token.agent_name, token.scope_name
            );
            return Ok(());
        }

        let status = result.status();
        let body: OAuthError = result.json().unwrap_or(OAuthError {
            error: "server_error".into(),
            error_description: None,
        });
        match body.error.as_str() {
            "authorization_pending" => continue,
            "slow_down" => {
                interval = interval.saturating_add(5);
                continue;
            }
            "access_denied" => bail!("sign-in was declined"),
            "expired_token" => bail!("the sign-in code expired; run `operate auth login` again"),
            _ => bail!(
                "sign-in failed (HTTP {}): {}",
                status,
                body.error_description.unwrap_or(body.error)
            ),
        }
    }
}

fn get_json(client: &Client, url: Url) -> Result<Value> {
    let response = client.get(url).send().context("request failed")?;
    decode_success(response)
}

fn decode_success<T: serde::de::DeserializeOwned>(
    response: reqwest::blocking::Response,
) -> Result<T> {
    let status = response.status();
    if !status.is_success() {
        let text = response.text().unwrap_or_default();
        bail!("server returned HTTP {status}: {}", short_text(&text));
    }
    response.json().context("server returned invalid JSON")
}

fn call_tool(
    client: &Client,
    origin: &Url,
    key: &str,
    tool: &str,
    arguments: Value,
) -> Result<Value> {
    mcp_request(
        client,
        origin,
        key,
        &json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"tools/call",
            "params":{"name":tool,"arguments":arguments}
        }),
        true,
    )
}

fn mcp_request(
    client: &Client,
    origin: &Url,
    key: &str,
    request: &Value,
    initialize: bool,
) -> Result<Value> {
    if initialize {
        let init = json!({
            "jsonrpc":"2.0",
            "id":1,
            "method":"initialize",
            "params":{
                "protocolVersion":MCP_PROTOCOL_VERSION,
                "capabilities":{},
                "clientInfo":{"name":"operate-cli","version":env!("CARGO_PKG_VERSION")}
            }
        });
        let _ = post_mcp(client, origin, key, &init)?;
        let initialized = json!({"jsonrpc":"2.0","method":"notifications/initialized"});
        let _ = post_mcp(client, origin, key, &initialized)?;
    }
    post_mcp(client, origin, key, request)?
        .ok_or_else(|| anyhow!("server returned no MCP response"))
}

fn post_mcp(client: &Client, origin: &Url, key: &str, message: &Value) -> Result<Option<Value>> {
    let response = client
        .post(origin.join("/api/mcp")?)
        .header(header::AUTHORIZATION, format!("Bearer {key}"))
        .header(header::ACCEPT, "application/json, text/event-stream")
        .header("Mcp-Protocol-Version", MCP_PROTOCOL_VERSION)
        .json(message)
        .send()
        .context("MCP request failed")?;
    let status = response.status();
    if status == StatusCode::ACCEPTED || status == StatusCode::NO_CONTENT {
        return Ok(None);
    }
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let body = response.text().context("could not read MCP response")?;
    if !status.is_success() {
        bail!("MCP server returned HTTP {status}: {}", short_text(&body));
    }
    parse_mcp_body(&content_type, &body)
}

fn parse_mcp_body(content_type: &str, body: &str) -> Result<Option<Value>> {
    let payload = if content_type.contains("text/event-stream") {
        body.lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("")
    } else {
        body.trim()
    };
    if payload.is_empty() {
        return Ok(None);
    }
    serde_json::from_str(payload)
        .map(Some)
        .context("server returned an invalid MCP response")
}

fn serve_stdio(client: &Client, origin: &Url, key: &str) -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.context("could not read MCP request from stdin")?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value =
            serde_json::from_str(&line).context("invalid JSON-RPC request on stdin")?;
        if let Some(response) = post_mcp(client, origin, key, &request)? {
            serde_json::to_writer(&mut stdout, &response)?;
            stdout.write_all(b"\n")?;
            stdout.flush()?;
        }
    }
    Ok(())
}

fn short_text(text: &str) -> String {
    const LIMIT: usize = 300;
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= LIMIT {
        compact
    } else {
        format!("{}…", compact.chars().take(LIMIT).collect::<String>())
    }
}

fn print_json(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_and_normalizes_to_an_origin() {
        assert_eq!(
            secure_origin("https://www.operate.to/path")
                .unwrap()
                .as_str(),
            "https://www.operate.to/"
        );
    }

    #[test]
    fn accepts_plain_http_only_for_loopback() {
        assert!(secure_origin("http://localhost:3000").is_ok());
        assert!(secure_origin("http://127.0.0.1:3000").is_ok());
        assert!(secure_origin("http://www.operate.to").is_err());
    }

    #[test]
    fn rejects_embedded_credentials_and_fragments() {
        assert!(secure_origin("https://user:pass@www.operate.to").is_err());
        assert!(secure_origin("https://www.operate.to/#other").is_err());
    }

    #[test]
    fn parses_json_and_sse_responses() {
        let value = parse_mcp_body("application/json", r#"{"jsonrpc":"2.0","id":1}"#)
            .unwrap()
            .unwrap();
        assert_eq!(value["id"], 1);
        let value = parse_mcp_body(
            "text/event-stream",
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2}\n\n",
        )
        .unwrap()
        .unwrap();
        assert_eq!(value["id"], 2);
    }
}

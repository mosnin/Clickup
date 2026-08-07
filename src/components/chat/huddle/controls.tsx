"use client";

// The audio controls: microphone and speaker.
//
// One rule governs every control in this file, and it is the reason the file
// reads the way it does: **a control that cannot do its job says so and is
// disabled — it is never drawn as working.** With no voice provider wired
// (`transport.ts`), muting mutes nothing, a device list selects nothing and a
// meter measures nothing; a person cannot tell a fake control from a broken
// one, and after one call in which the mute button did not mute they stop
// believing the rest of the interface too.
//
// So every control here asks the transport what it can actually do
// (`capabilities`), disables itself with the transport's own sentence when it
// cannot, and never renders a value it did not measure.
//
// What is deliberately absent (04-huddle-media §1.21): there is **no deafen**.
// The speaker control silences synthesized agent speech and nothing else — no
// control anywhere in a huddle mutes another human, and the naming is the
// enforcement.

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check, Mic, MicOff, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover } from "@/components/chat/transcript/popover";
import { useHuddle } from "./huddle-provider";

/** The chord Buzz binds, and the label the bar shows next to the toggle. */
export const PUSH_TO_TALK_HINT = "Ctrl + Space";

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export type AudioDevice = { deviceId: string; label: string };

/**
 * The machine's audio devices, enumerated only when they can be used.
 *
 * `enumerateDevices` is a browser API and works with no provider at all — which
 * is exactly why it is gated on `enabled` rather than on availability. A device
 * list that populates beautifully and changes nothing is the most convincing
 * lie this surface could tell. Labels are also empty until microphone
 * permission has been granted, so an ungated list would additionally be a
 * column of blank rows.
 */
export function useAudioDevices(
  kind: "audioinput" | "audiooutput",
  enabled: boolean,
): AudioDevice[] {
  const [devices, setDevices] = useState<AudioDevice[]>([]);

  useEffect(() => {
    if (!enabled) {
      setDevices([]);
      return;
    }
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (!media?.enumerateDevices) return;
    let cancelled = false;
    const read = () => {
      void media
        .enumerateDevices()
        .then((found) => {
          if (cancelled) return;
          setDevices(
            found
              .filter((device) => device.kind === kind)
              .map((device, index) => ({
                deviceId: device.deviceId,
                label: device.label || `${kind === "audioinput" ? "Microphone" : "Speaker"} ${index + 1}`,
              })),
          );
        })
        .catch(() => {
          // A browser that refuses to enumerate is a browser with no device
          // choice, which is a smaller loss than a list that lies.
        });
    };
    read();
    media.addEventListener?.("devicechange", read);
    return () => {
      cancelled = true;
      media.removeEventListener?.("devicechange", read);
    };
  }, [kind, enabled]);

  return devices;
}

function DeviceList({
  label,
  devices,
  selected,
  onSelect,
  footnote,
}: {
  label: string;
  devices: AudioDevice[];
  selected: string | null;
  onSelect: (deviceId: string | null) => void;
  footnote?: string;
}) {
  return (
    <div className="flex flex-col gap-1 px-1 py-1.5">
      <p className="chat-quiet px-2 text-micro font-semibold uppercase tracking-wider">
        {label}
      </p>
      <ul className="flex flex-col">
        {[{ deviceId: "", label: "System default" }, ...devices].map((device) => {
          const value = device.deviceId === "" ? null : device.deviceId;
          const active = selected === value;
          return (
            <li key={device.deviceId || "default"}>
              <button
                type="button"
                aria-checked={active}
                role="menuitemradio"
                onClick={() => onSelect(value)}
                className="tap-target flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-mini hover:bg-black/5 dark:hover:bg-white/10"
              >
                <span className="w-4 shrink-0">
                  {active ? <Check aria-hidden className="h-3.5 w-3.5" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{device.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {footnote ? (
        <p className="chat-quiet px-2 pt-1 text-tiny leading-snug">{footnote}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The microphone
// ---------------------------------------------------------------------------

/**
 * A three-bar level meter, driven by a level the transport measured.
 *
 * Frozen at rest under `prefers-reduced-motion`, and — more importantly —
 * frozen at rest when nothing is measuring: `localLevel` is 0 with no provider,
 * so the bars sit still rather than shimmering at a number nobody produced.
 */
function MicMeter({ level, muted }: { level: number; muted: boolean }) {
  const heights = [0.45, 1, 0.7].map((weight) =>
    muted ? 0.25 : Math.max(0.25, Math.min(1, level * weight * 1.6)),
  );
  return (
    <span aria-hidden className="flex h-3.5 w-3 items-end justify-center gap-[2px]">
      {heights.map((height, index) => (
        <span
          key={index}
          style={{ height: `${Math.round(height * 100)}%` }}
          className="w-[2px] rounded-full bg-current transition-[height] duration-100 motion-reduce:transition-none"
        />
      ))}
    </span>
  );
}

export function MicControls() {
  const { session, transport, mediaLive, localLevel, transmitting, dispatch } = useHuddle();
  const canUseAudio = transport.capabilities.microphone && mediaLive;
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const devices = useAudioDevices("audioinput", transport.capabilities.deviceSelection && mediaLive);

  const reason = transport.unavailableReason ?? "The audio path is not up yet.";
  const muteLabel =
    session.inputMode === "push_to_talk"
      ? "Force mute (overrides push to talk)"
      : session.micMuted
        ? "Unmute"
        : "Mute";

  return (
    <div className="flex items-stretch overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
      <button
        type="button"
        aria-pressed={session.micMuted}
        aria-disabled={!canUseAudio}
        disabled={!canUseAudio}
        title={canUseAudio ? muteLabel : reason}
        data-testid="huddle-mic-toggle"
        onClick={() => dispatch({ type: "set_mic_muted", muted: !session.micMuted })}
        className={cn(
          "tap-target flex items-center gap-1.5 px-3 py-1.5 text-mini font-medium",
          canUseAudio ? "hover:bg-black/5 dark:hover:bg-white/10" : "cursor-not-allowed opacity-45",
          session.micMuted && canUseAudio ? "text-red-600 dark:text-red-400" : "",
        )}
      >
        {session.micMuted || !canUseAudio ? (
          <MicOff aria-hidden className="h-4 w-4" />
        ) : (
          <Mic aria-hidden className="h-4 w-4" />
        )}
        <span className="sr-only">{muteLabel}</span>
        <span aria-hidden className="hidden sm:inline">
          {transmitting ? "Live" : session.micMuted ? "Muted" : "Mic"}
        </span>
      </button>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Microphone options"
        data-testid="huddle-mic-options"
        onClick={() => setOpen((value) => !value)}
        className="tap-target flex items-center px-2 hover:bg-black/5 dark:hover:bg-white/10"
      >
        {open ? (
          <ChevronDown aria-hidden className="h-3.5 w-3.5" />
        ) : (
          <MicMeter level={localLevel} muted={session.micMuted || !canUseAudio} />
        )}
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        label="Microphone options"
        className="w-72 p-1"
      >
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-3 px-2 py-1.5">
            <span className="text-mini font-medium">Push to talk</span>
            <span className="flex items-center gap-2">
              <kbd className="chat-quiet rounded border border-black/10 px-1 py-0.5 text-micro dark:border-white/15">
                {PUSH_TO_TALK_HINT}
              </kbd>
              <button
                type="button"
                role="switch"
                aria-checked={session.inputMode === "push_to_talk"}
                aria-label="Push to talk"
                data-testid="huddle-ptt-toggle"
                onClick={() =>
                  dispatch({
                    type: "set_input_mode",
                    mode: session.inputMode === "push_to_talk" ? "voice_activity" : "push_to_talk",
                  })
                }
                className={cn(
                  "tap-target h-5 w-9 shrink-0 rounded-full transition-colors",
                  session.inputMode === "push_to_talk"
                    ? "bg-foreground"
                    : "bg-black/15 dark:bg-white/20",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "block h-4 w-4 translate-x-0.5 rounded-full bg-white transition-transform motion-reduce:transition-none",
                    session.inputMode === "push_to_talk" ? "translate-x-[1.125rem]" : "",
                  )}
                />
              </button>
            </span>
          </div>

          <label className="flex flex-col gap-1 px-2 py-1.5">
            <span className="flex items-center justify-between text-mini font-medium">
              Input volume
              <span className="chat-quiet tabular-nums">{Math.round(session.gain * 100)}%</span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={session.gain}
              disabled={!canUseAudio}
              aria-label="Input volume"
              data-testid="huddle-gain"
              onChange={(event) =>
                dispatch({ type: "set_gain", gain: Number(event.target.value) })
              }
              className="soft-field h-1.5 w-full appearance-none rounded-full disabled:opacity-45"
            />
          </label>

          {transport.capabilities.deviceSelection ? (
            <DeviceList
              label="Microphone"
              devices={devices}
              selected={session.inputDeviceId}
              onSelect={(deviceId) => dispatch({ type: "set_input_device", deviceId })}
              footnote="A change takes effect on the next huddle."
            />
          ) : (
            <p className="chat-quiet px-2 py-1.5 text-tiny leading-snug">
              {/* The transport's own sentence, verbatim. A paraphrase here would
                  be a second description of one deployment fact, and the two
                  would eventually say different things. */}
              {reason}
            </p>
          )}
        </div>
      </Popover>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The speaker
// ---------------------------------------------------------------------------

/**
 * Silence synthesized agent speech.
 *
 * The closest thing a huddle has to "deafen", and it is deliberately not one:
 * it silences machines, never people. It stays usable with no provider only in
 * the sense that the *preference* is remembered — which is why it is disabled
 * here too rather than toggling a flag nothing reads.
 */
export function SpeakerControls() {
  const { session, transport, mediaLive, dispatch } = useHuddle();
  const canUseAudio = transport.capabilities.agentSpeech && mediaLive;
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const devices = useAudioDevices("audiooutput", transport.capabilities.deviceSelection && mediaLive);
  const reason = transport.unavailableReason ?? "The audio path is not up yet.";

  return (
    <div className="flex items-stretch overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
      <button
        type="button"
        aria-pressed={session.speakerMuted}
        aria-disabled={!canUseAudio}
        disabled={!canUseAudio}
        data-testid="huddle-speaker-toggle"
        title={
          canUseAudio
            ? session.speakerMuted
              ? "Let agents speak"
              : "Silence agent speech (people are never muted)"
            : reason
        }
        onClick={() => dispatch({ type: "set_speaker_muted", muted: !session.speakerMuted })}
        className={cn(
          "tap-target flex items-center gap-1.5 px-3 py-1.5 text-mini font-medium",
          canUseAudio ? "hover:bg-black/5 dark:hover:bg-white/10" : "cursor-not-allowed opacity-45",
          session.speakerMuted && canUseAudio ? "text-red-600 dark:text-red-400" : "",
        )}
      >
        {session.speakerMuted || !canUseAudio ? (
          <VolumeX aria-hidden className="h-4 w-4" />
        ) : (
          <Volume2 aria-hidden className="h-4 w-4" />
        )}
        <span className="sr-only">
          {session.speakerMuted ? "Let agents speak" : "Silence agent speech"}
        </span>
      </button>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Speaker options"
        onClick={() => setOpen((value) => !value)}
        className="tap-target flex items-center px-2 hover:bg-black/5 dark:hover:bg-white/10"
      >
        <ChevronDown aria-hidden className="h-3.5 w-3.5" />
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        label="Speaker options"
        className="w-72 p-1"
      >
        {transport.capabilities.deviceSelection ? (
          <DeviceList
            label="Speaker"
            devices={devices}
            selected={session.outputDeviceId}
            onSelect={(deviceId) => dispatch({ type: "set_output_device", deviceId })}
          />
        ) : (
          <p className="chat-quiet px-2 py-1.5 text-tiny leading-snug">{reason}</p>
        )}
        <p className="chat-quiet border-t border-black/5 px-2 py-1.5 text-tiny leading-snug dark:border-white/10">
          This silences agent speech only. Nothing here mutes another person.
        </p>
      </Popover>
    </div>
  );
}

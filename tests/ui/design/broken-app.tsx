import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// The instrument, pointed at defects it is supposed to find.
//
// **A gate that has never detected a known defect cannot be trusted to report
// its absence.** That sentence is the whole reason this file exists. An audit
// that returns green from an uncalibrated instrument is not evidence of
// anything — it is the downscaled-screenshot failure again, where the auditor
// was not lying and simply could not see.
//
// So every gate in `scripts/audit-gates.mjs` gets a matched pair here:
//
//   - `data-calib="<gate>"`     a specimen the gate MUST fire on
//   - `data-calib-ok="<gate>"`  a clean control the gate must stay quiet on
//
// The control is not decoration. A gate that fires on everything is as
// useless as one that fires on nothing, and the `tap` control is the sharpest
// case in the file: a 30px button carrying `.tap-target`, whose `::after`
// hit-area makes it a legal 47px target. A tap gate that measured the painted
// box would report that as a defect, forty times over, on every real screen —
// and a gate people mute is a gate that is off.
//
// Colours here are literals rather than design tokens on purpose. This file
// asserts that the MEASUREMENT works; if it read tokens, retuning a token
// would silently decalibrate the instrument, which is precisely the class of
// silent failure the audit exists to prevent.
//
//   ?defect=overflow   the 390px horizontal-overflow specimen, alone
//   ?defect=gesture    a grid that writes per frame and lands somewhere else
//   (no query)         every element-level specimen and its control

const params = new URLSearchParams(window.location.search);
const DEFECT = params.get("defect");

const CARD: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: 12,
  padding: 14,
  marginBottom: 10,
};

function Specimen({
  gate,
  what,
  broken,
  clean,
}: {
  gate: string;
  what: string;
  broken: React.ReactNode;
  clean: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 26 }}>
      <h2
        style={{
          font: "600 13px/1.4 system-ui, sans-serif",
          color: "#111111",
          margin: "0 0 8px",
        }}
      >
        {gate} — {what}
      </h2>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <div style={{ width: 320 }}>
          <p style={LABEL}>must fire</p>
          <div data-calib={gate} style={CARD}>
            {broken}
          </div>
        </div>
        <div style={{ width: 320 }}>
          <p style={LABEL}>must stay quiet</p>
          <div data-calib-ok={gate} style={CARD}>
            {clean}
          </div>
        </div>
      </div>
    </section>
  );
}

const LABEL: React.CSSProperties = {
  font: "500 10px/1.4 system-ui, sans-serif",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "#444444",
  margin: "0 0 6px",
};

/** A tile pair that shares pixels, and one that does not. */
function OverlapPair({ broken }: { broken: boolean }) {
  return (
    <div style={{ position: "relative", height: 90 }}>
      <div
        data-tile="left"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 160,
          height: 80,
          background: "#e8eaf6",
          borderRadius: 8,
        }}
      />
      <div
        data-tile="right"
        style={{
          position: "absolute",
          left: broken ? 90 : 170,
          top: 0,
          width: 120,
          height: 80,
          background: "#fce4ec",
          borderRadius: 8,
        }}
      />
    </div>
  );
}

/** A tile whose content is taller than the box it was given, and one that fits. */
function SpillTile({ broken }: { broken: boolean }) {
  return (
    <div
      data-tile={broken ? "spilling" : "fitting"}
      style={{
        height: 70,
        width: 260,
        background: "#e8eaf6",
        borderRadius: 8,
        // No clipping: the whole point of the defect is that the tile does not
        // contain what it holds, which is how Home came to paint every panel
        // over the one below it while the box maths was correct.
        overflow: "visible",
      }}
    >
      <div data-tile-inner style={{ height: broken ? 150 : 60 }}>
        <div
          style={{
            height: "100%",
            background: "#c5cae9",
            borderRadius: 8,
          }}
        />
      </div>
    </div>
  );
}

/** SVG marks: one painted with a custom property nothing defines. */
function InkCard({ broken }: { broken: boolean }) {
  return (
    <div style={{ background: "#0b0b0c", borderRadius: 8, padding: 10 }}>
      <svg height="80" width="240">
        {[0, 1, 2, 3].map((i) => (
          <rect
            height={20 + i * 14}
            key={i}
            width={40}
            x={i * 56}
            y={78 - (20 + i * 14)}
            // `fill: var(--x)` with no `--x` is invalid at computed-value
            // time, so it falls back to the initial value — black — on a black
            // card. Nothing in the DOM is wrong. Only the pixels are, which is
            // the exact bug this project shipped inside a vendored chart.
            style={{ fill: broken ? "var(--audit-undefined-token)" : "#7aa2ff" }}
          />
        ))}
      </svg>
    </div>
  );
}

function GesturePage({ clean }: { clean: boolean }) {
  // A grid that behaves the three ways the rubric caps at 5: it writes on
  // every frame of a gesture, it commits a height other than the one the
  // pointer was released at, and a reorder lands and then corrects itself
  // after the fact — the "saves out of place then glitches in" that was
  // reported by a person twice and passed by jsdom twice.
  //
  // The DOM contract is the real grid's — `[data-tile]`, `#write-count`,
  // `#layout-json`, a grip labelled "Resize <title>" — so the SAME checker
  // runs against both this and the real thing. A calibration fixture that
  // needed its own checker would prove nothing about the checker that ships.
  const [rows, setRows] = useState(1);
  const [writes, setWrites] = useState(0);
  const [committed, setCommitted] = useState(1);
  const [order, setOrder] = useState(["a", "b"]);
  const start = useRef<{ y: number; rows: number } | null>(null);
  const dragging = useRef(false);

  function Tile({ id }: { id: string }) {
    const isA = id === "a";
    return (
      <div
        data-tile={id}
        key={id}
        onPointerDown={(e) => {
          if (!isA) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          dragging.current = true;
        }}
        onPointerMove={() => {
          if (!dragging.current) return;
          // Defect: a write on every slot crossing, and the crossings race.
          if (!clean) setWrites((n) => n + 1);
          setOrder(["b", "a"]);
        }}
        onPointerUp={() => {
          if (!dragging.current) return;
          dragging.current = false;
          // One gesture, one intention, one write.
          if (clean) setWrites((n) => n + 1);
          // Defect: a late write lands after the drop and puts it back. A
          // single reading taken right after release cannot see this, which
          // is why the checker looks twice.
          if (!clean) setTimeout(() => setOrder(["a", "b"]), 350);
        }}
        style={{
          width: 300,
          height: isA ? 80 * rows : 80,
          marginTop: isA ? 0 : 12,
          background: isA ? "#e8eaf6" : "#fce4ec",
          borderRadius: 8,
          position: "relative",
          touchAction: "none",
        }}
      >
        <div data-tile-inner style={{ height: "100%" }} />
        {isA && (
          <button
            aria-label="Resize Today. 1 of 3 columns, 1 rows tall. Drag to resize."
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              start.current = { y: e.clientY, rows };
            }}
            onPointerMove={(e) => {
              if (!start.current) return;
              e.stopPropagation();
              const next = Math.max(
                1,
                Math.round(
                  start.current.rows + (e.clientY - start.current.y) / 80,
                ),
              );
              setRows(next);
              // Defect: a write per frame. Racing writes are what made a drop
              // land in the wrong place and then jump.
              if (!clean) setWrites((n) => n + 1);
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
              start.current = null;
              // Defect: the committed value is not where the pointer was
              // released. A visible correction after release means the screen
              // disagreed with the gesture.
              if (clean) {
                setCommitted(rows);
                setWrites((n) => n + 1);
              } else {
                setCommitted(1);
                setRows(1);
              }
            }}
            style={{
              position: "absolute",
              right: 0,
              bottom: 0,
              width: 44,
              height: 44,
              background: "#9fa8da",
              border: 0,
              borderRadius: 8,
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: 20 }}>
      {order.map((id) => (
        <Tile id={id} key={id} />
      ))}
      <pre
        data-audit-ignore
        id="layout-json"
        style={{ fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-all" }}
      >
        {JSON.stringify({
          widgets: order.map((id) => ({
            id,
            span: 1,
            rows: id === "a" ? committed : undefined,
          })),
        })}
      </pre>
      <pre data-audit-ignore id="write-count" style={{ fontSize: 11 }}>
        {writes}
      </pre>
    </div>
  );
}

function OverflowPage() {
  // One unwrapped line, wider than a phone. This is the harness bug that made
  // every "390px" shot in this project really 646px wide — a shot that lies is
  // more expensive than no shot, so the gate that catches it is calibrated.
  return (
    <div style={{ padding: 16 }}>
      <p
        style={{
          font: "400 12px/1.5 system-ui, sans-serif",
          color: "#111111",
          whiteSpace: "nowrap",
        }}
      >
        {"widgets:[{id:'stats',span:3},{id:'today',span:2},{id:'activity',span:1}]"}
      </p>
    </div>
  );
}

function Page() {
  // Both sides of the gesture calibration. A gate proved only on the broken
  // fixture cannot be told apart from a gate that fires on everything, and a
  // gate that fires on everything is one somebody eventually switches off.
  if (DEFECT === "gesture") return <GesturePage clean={false} />;
  if (DEFECT === "gesture-ok") return <GesturePage clean />;
  if (DEFECT === "overflow") return <OverflowPage />;
  return (
    <div style={{ padding: 20, maxWidth: 720 }}>
      <h1 style={{ font: "700 18px/1.3 system-ui, sans-serif", color: "#111111" }}>
        Calibration specimens
      </h1>
      <p
        style={{
          font: "400 12px/1.6 system-ui, sans-serif",
          color: "#333333",
          maxWidth: 560,
        }}
      >
        Every gate must fire on the left and stay quiet on the right. A run that
        cannot show this returns unknown, not a score.
      </p>

      <Specimen
        broken={<OverlapPair broken />}
        clean={<OverlapPair broken={false} />}
        gate="overlap"
        what="two panels share pixels"
      />

      <Specimen
        broken={<SpillTile broken />}
        clean={<SpillTile broken={false} />}
        gate="spill"
        what="content escapes its tile"
      />

      <Specimen
        broken={
          <>
            <p style={{ font: "400 13px system-ui", color: "#111111" }}>
              Due in NaN days
            </p>
            <p style={{ font: "400 13px system-ui", color: "#111111" }}>
              Assigned to undefined
            </p>
            {/* A control nobody can name: a glyph with no label. */}
            <button
              onClick={() => {}}
              style={{
                width: 44,
                height: 44,
                border: 0,
                background: "#e0e0e0",
                borderRadius: 8,
              }}
            >
              <svg height="16" width="16">
                <rect fill="#333333" height="16" width="16" />
              </svg>
            </button>
          </>
        }
        clean={
          <>
            <p style={{ font: "400 13px system-ui", color: "#111111" }}>
              Due in 3 days
            </p>
            <p style={{ font: "400 13px system-ui", color: "#111111" }}>
              Assigned to Ada Lovelace
            </p>
            <button
              aria-label="Remove this panel"
              onClick={() => {}}
              style={{
                width: 44,
                height: 44,
                border: 0,
                background: "#e0e0e0",
                borderRadius: 8,
              }}
            >
              <svg height="16" width="16">
                <rect fill="#333333" height="16" width="16" />
              </svg>
            </button>
          </>
        }
        gate="junk"
        what="a value that was never computed, and a control with no name"
      />

      <Specimen
        broken={
          <>
            {/* 3.05:1 — passes nothing at 13px. */}
            <p style={{ font: "400 13px system-ui", color: "#8a8a8a" }}>
              Last synced 4 minutes ago
            </p>
            {/* The transparent-ancestor case: the colour it was GIVEN is fine,
                the colour it lands on is not. */}
            <div style={{ background: "#f2f2f2" }}>
              <div style={{ background: "transparent" }}>
                <p style={{ font: "400 12px system-ui", color: "#a8a8a8" }}>
                  3 of 41 shown
                </p>
              </div>
            </div>
            {/* Written in oklch, which is what this app is written in. A gate
                that parsed `rgb(...)` with a regex would read this as black
                and pass it, which is the gate failing through itself. */}
            <p style={{ font: "400 13px system-ui", color: "oklch(0.82 0 0)" }}>
              Nothing due today
            </p>
          </>
        }
        clean={
          <>
            <p style={{ font: "400 13px system-ui", color: "#565656" }}>
              Last synced 4 minutes ago
            </p>
            <div style={{ background: "#f2f2f2" }}>
              <div style={{ background: "transparent" }}>
                <p style={{ font: "400 12px system-ui", color: "#3d3d3d" }}>
                  3 of 41 shown
                </p>
              </div>
            </div>
            <p style={{ font: "400 13px system-ui", color: "oklch(0.45 0 0)" }}>
              Nothing due today
            </p>
          </>
        }
        gate="contrast"
        what="text against what is actually behind it"
      />

      <Specimen
        broken={<InkCard broken />}
        clean={<InkCard broken={false} />}
        gate="ink"
        what="a mark painted with a custom property nothing defines"
      />

      <Specimen
        broken={
          <div
            style={{
              width: 120,
              height: 18,
              overflow: "hidden",
              font: "400 13px system-ui",
              color: "#111111",
            }}
          >
            Reconcile the September ledger export before the cutover window
          </div>
        }
        clean={
          <div
            style={{
              width: 120,
              height: 18,
              overflow: "hidden",
              font: "400 13px system-ui",
              color: "#111111",
            }}
          >
            Reconcile
          </div>
        }
        gate="clipped"
        what="text cut off with nothing to say so"
      />

      <Specimen
        broken={
          <div
            style={{
              width: 120,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              font: "400 13px system-ui",
              color: "#111111",
            }}
          >
            Billing migration — Stripe to internal ledger
          </div>
        }
        clean={
          <div
            style={{
              width: 120,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              font: "400 13px system-ui",
              color: "#111111",
            }}
          >
            Billing
          </div>
        }
        gate="truncated"
        what="text ellipsised"
      />

      <Specimen
        broken={
          <button
            aria-label="Close"
            onClick={() => {}}
            style={{
              width: 20,
              height: 20,
              border: 0,
              background: "#e0e0e0",
              borderRadius: 6,
            }}
          />
        }
        clean={
          <div style={{ display: "flex", gap: 10 }}>
            <button
              aria-label="Close"
              onClick={() => {}}
              style={{
                width: 44,
                height: 44,
                border: 0,
                background: "#e0e0e0",
                borderRadius: 8,
              }}
            />
            {/* The control that matters most in this file: 30px painted, but
                `.tap-target` hangs a -0.55rem `::after` under a coarse
                pointer, so the real target is ~47px. A gate that measured the
                painted box would call this broken on every screen in the
                product, and a gate people mute is a gate that is off. */}
            <button
              aria-label="Start timer"
              className="tap-target"
              onClick={() => {}}
              style={{
                width: 30,
                height: 30,
                border: 0,
                background: "#e0e0e0",
                borderRadius: 8,
              }}
            />
          </div>
        }
        gate="tap"
        what="a target too small for a thumb"
      />

      <Specimen
        broken={
          <button
            style={{
              width: 120,
              height: 44,
              border: 0,
              background: "#e0e0e0",
              borderRadius: 8,
              font: "500 13px system-ui",
              color: "#111111",
            }}
          >
            Apply preset
          </button>
        }
        clean={
          <button
            onClick={() => {}}
            style={{
              width: 120,
              height: 44,
              border: 0,
              background: "#e0e0e0",
              borderRadius: 8,
              font: "500 13px system-ui",
              color: "#111111",
            }}
          >
            Apply preset
          </button>
        }
        gate="inert"
        what="a control with nothing behind it"
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);

"use client";

// The Notifications section of Chat settings (05-shell-design §7.4).
//
// Eight slots, three switches and a picker each — which is a lot of controls,
// and the arrangement is the argument against it becoming a wall. The four
// agent slots are real, wired end to end, and emitted by nothing yet, so they
// are folded behind "View all" with a Coming soon chip rather than sitting
// disabled at eye level: a control that cannot do anything is worse than an
// absent one, but a control that is *about to* exist is worth saying.
//
// Three things this deliberately does not do.
//
// **No save button.** Every toggle is a write, the way the appearance studio
// works and for the same reason — a settings screen with a save button is a
// screen you can leave in a state you did not choose. The stored value is the
// truth; a local draft covers only the round trip, and a refused write drops
// the draft and says so in a toast rather than leaving the switch lying.
//
// **No optimistic permission.** Turning desktop alerts on asks the browser
// first and records what the browser answered. §7.3's rule: a request that
// comes back anything other than "granted" forces the switch back off and
// explains why. Recording an intent the platform will not honour produces a
// screen that says alerts are on while nothing arrives, which is the worst
// possible state for this particular setting.
//
// **No icons.** The house rule, and it costs nothing here: every row is a label
// and a control, and a bell beside the word "Notifications" tells nobody
// anything they did not get from the word.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { Picker } from "@/components/ui/picker";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import {
  COMING_SOON_SLOTS,
  DEFAULT_NOTIFICATION_SETTINGS,
  SLOT_DESCRIPTIONS,
  SLOT_LABELS,
  SOUND_NAMES,
  SOUND_SLOTS,
  allSlotAlertsEnabled,
  resolveSlotSound,
  setAllSlotAlertsEnabled,
  setSlotAlertEnabled,
  type NotificationSettings,
  type SoundName,
  type SoundSlot,
} from "@/lib/buzz/notify";
import {
  currentPermission,
  permissionMessage,
  requestPermission,
  type NotificationPermissionState,
} from "./desktop";
import { playSound, recommendedSoundFor } from "./sound";
import {
  setAllSlotAlertsMutation,
  setFlagMutation,
  setSlotAlertMutation,
  setSoundMutation,
  settingsQuery,
} from "./refs";

const COMING_SOON = new Set<SoundSlot>(COMING_SOON_SLOTS);
const EVERYDAY_SLOTS = SOUND_SLOTS.filter((slot) => !COMING_SOON.has(slot));

// ---------------------------------------------------------------------------
// Row vocabulary (§7.3) — a grouped iOS-style card, no borders, no dividers
// ---------------------------------------------------------------------------

function OptionGroup({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-2xl bg-muted/20">{children}</div>;
}

function OptionRow({
  label,
  description,
  control,
  disabled = false,
  badge,
}: {
  label: string;
  description?: string;
  control: ReactNode;
  disabled?: boolean;
  badge?: string;
}) {
  return (
    <div
      aria-disabled={disabled || undefined}
      className={cn(
        "ui-dense-pad flex min-h-16 items-center justify-between gap-4 px-4 py-3 text-sm",
        disabled && "opacity-40",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{label}</span>
          {badge ? (
            <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {badge}
            </span>
          ) : null}
        </div>
        {description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">{control}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * A sound cannot be drawn, so it is played.
 *
 * The house rule for a customisation control is "if it can be drawn it must be
 * drawn, over the reader's own content" — the point being that a specimen must
 * *be* the thing rather than a picture of it. The audible analogue is that
 * choosing a sound plays it, immediately, at the moment of choosing. A name in
 * a dropdown is exactly the "picture of" the rule warns about: nobody knows
 * what `doong` is.
 */
function SoundPicker({
  slot,
  value,
  disabled,
  onChange,
}: {
  slot: SoundSlot;
  value: SoundName;
  disabled?: boolean;
  onChange: (sound: SoundName) => void;
}) {
  const recommended = recommendedSoundFor(slot);
  const options = useMemo(
    () =>
      SOUND_NAMES.map((name) => ({
        id: name,
        label: name,
        hint: name === recommended ? "suggested" : undefined,
      })),
    [recommended],
  );
  return (
    <Picker
      options={options}
      selectedId={value}
      label={value}
      disabled={disabled}
      onSelect={(id) => {
        const sound = id as SoundName;
        playSound(sound);
        onChange(sound);
      }}
      className="min-w-28"
    />
  );
}

export function NotificationSettingsPanel({ className }: { className?: string }) {
  const stored = useQuery(settingsQuery, {});
  const setFlag = useMutation(setFlagMutation);
  const setSlotAlert = useMutation(setSlotAlertMutation);
  const setAllSlotAlerts = useMutation(setAllSlotAlertsMutation);
  const setSound = useMutation(setSoundMutation);
  const { toast } = useToast();

  // The draft covers the round trip and nothing else — see the header. It is
  // cleared whenever a fresh server value arrives, so two devices editing the
  // same row converge instead of one of them holding a stale draft forever.
  const [draft, setDraft] = useState<NotificationSettings | null>(null);
  useEffect(() => {
    setDraft(null);
  }, [stored]);

  const [permission, setPermission] = useState<NotificationPermissionState>("unsupported");
  const [requesting, setRequesting] = useState(false);
  const [showComingSoon, setShowComingSoon] = useState(false);

  useEffect(() => {
    setPermission(currentPermission());
  }, []);

  const settings = draft ?? stored ?? DEFAULT_NOTIFICATION_SETTINGS;
  const loading = stored === undefined;
  const alertsOn = settings.desktopEnabled;
  const soundsOn = allSlotAlertsEnabled(settings);
  const blocked = permissionMessage(permission);

  async function run(optimistic: NotificationSettings, write: () => Promise<unknown>) {
    setDraft(optimistic);
    try {
      await write();
    } catch (err) {
      setDraft(null);
      toast(err instanceof Error ? err.message : "Could not save that", { kind: "error" });
    }
  }

  /**
   * Turning alerts on asks the platform first (§7.3).
   *
   * Turning them off never prompts — nothing needs permission to be quiet, and
   * a prompt on the way out would be the most confusing possible moment for
   * one.
   */
  async function toggleDesktop(next: boolean) {
    if (!next) {
      await run({ ...settings, desktopEnabled: false }, () =>
        setFlag({ key: "desktopEnabled", value: false }),
      );
      return;
    }
    setRequesting(true);
    const state = await requestPermission();
    setPermission(state);
    setRequesting(false);
    if (state !== "granted") {
      // The intent is not recorded. A switch that reads "on" while the browser
      // refuses to show anything is the one state this setting must never be
      // left in.
      const message = permissionMessage(state);
      if (message) toast(message, { kind: "error" });
      return;
    }
    await run({ ...settings, desktopEnabled: true }, () =>
      setFlag({ key: "desktopEnabled", value: true }),
    );
  }

  return (
    <section className={cn("mx-auto w-full max-w-2xl", className)}>
      <header className="mb-8">
        <h1 className="title-rule text-2xl font-bold tracking-tight">Notifications</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Desktop alerts are on by default. Fine-tune what gets through below.
        </p>
      </header>

      {blocked ? (
        <p
          role="status"
          className="mb-6 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {blocked}
        </p>
      ) : null}

      <div className={cn("space-y-8", loading && "pointer-events-none opacity-60")}>
        <OptionGroup>
          <OptionRow
            label="Desktop alerts"
            description="A notification from your browser when something needs you."
            control={
              <Switch
                checked={alertsOn}
                disabled={requesting || loading}
                label={requesting ? "Requesting..." : "Desktop alerts"}
                onCheckedChange={(next) => void toggleDesktop(next)}
              />
            }
          />
          <OptionRow
            label="Notify while viewing"
            description="Also alert for direct messages in the conversation you have open."
            disabled={!alertsOn}
            control={
              <Switch
                checked={settings.notifyWhileViewing}
                disabled={!alertsOn || loading}
                label="Notify while viewing"
                onCheckedChange={(next) =>
                  void run({ ...settings, notifyWhileViewing: next }, () =>
                    setFlag({ key: "notifyWhileViewing", value: next }),
                  )
                }
              />
            }
          />
          <OptionRow
            label="Home badge"
            description="Show a Home badge for mentions and needs-action items in the sidebar."
            control={
              <Switch
                checked={settings.homeBadgeEnabled}
                disabled={loading}
                label="Home badge"
                onCheckedChange={(next) =>
                  void run({ ...settings, homeBadgeEnabled: next }, () =>
                    setFlag({ key: "homeBadgeEnabled", value: next }),
                  )
                }
              />
            }
          />
        </OptionGroup>

        <div>
          <h2 className="mb-3 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Sound
          </h2>
          <OptionGroup>
            <OptionRow
              label="Sound"
              description={
                soundsOn
                  ? "Turning this off remembers each row below, so turning it back on restores them."
                  : "Every alert below is silenced. Your individual picks are remembered."
              }
              control={
                <Switch
                  checked={soundsOn}
                  disabled={loading}
                  label="All sounds"
                  onCheckedChange={(next) =>
                    void run(setAllSlotAlertsEnabled(settings, next), () =>
                      setAllSlotAlerts({ enabled: next }),
                    )
                  }
                />
              }
            />
            {EVERYDAY_SLOTS.map((slot) => (
              <SlotRow
                key={slot}
                slot={slot}
                settings={settings}
                disabled={loading}
                onToggle={(enabled) =>
                  void run(setSlotAlertEnabled(settings, slot, enabled), () =>
                    setSlotAlert({ slot, enabled }),
                  )
                }
                onSound={(sound) =>
                  void run(
                    { ...settings, sounds: { ...settings.sounds, [slot]: sound } },
                    () => setSound({ slot, sound }),
                  )
                }
              />
            ))}
            {showComingSoon
              ? COMING_SOON_SLOTS.map((slot) => (
                  <SlotRow key={slot} slot={slot} settings={settings} disabled comingSoon />
                ))
              : null}
          </OptionGroup>
          <button
            type="button"
            onClick={() => setShowComingSoon((open) => !open)}
            className="tap-target mt-2 px-1 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {showComingSoon ? "Show less" : "View all"}
          </button>
        </div>
      </div>
    </section>
  );
}

function SlotRow({
  slot,
  settings,
  disabled,
  comingSoon = false,
  onToggle,
  onSound,
}: {
  slot: SoundSlot;
  settings: NotificationSettings;
  disabled?: boolean;
  comingSoon?: boolean;
  onToggle?: (enabled: boolean) => void;
  onSound?: (sound: SoundName) => void;
}) {
  return (
    <OptionRow
      label={SLOT_LABELS[slot]}
      description={SLOT_DESCRIPTIONS[slot]}
      disabled={comingSoon}
      badge={comingSoon ? "Coming soon" : undefined}
      control={
        <>
          <SoundPicker
            slot={slot}
            value={resolveSlotSound(settings, slot)}
            disabled={disabled || comingSoon}
            onChange={(sound) => onSound?.(sound)}
          />
          <Switch
            checked={settings.slotAlertsEnabled[slot]}
            disabled={disabled || comingSoon}
            label={SLOT_LABELS[slot]}
            onCheckedChange={(next) => onToggle?.(next)}
          />
        </>
      }
    />
  );
}

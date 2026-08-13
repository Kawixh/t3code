import type {
  DesktopBridge,
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from "@t3tools/contracts";
import { DownloadIcon, RefreshCwIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { type CSSProperties, useCallback, useState } from "react";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import {
  canCheckForUpdate,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
import { showDesktopUpdateDownloadedToast } from "../desktopUpdate.toast";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Separator } from "../ui/separator";
import { SidebarMenuItem } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const UPDATE_AVAILABLE_TOOLTIP_STYLE: CSSProperties = {
  background:
    "color-mix(in srgb, var(--update) 18%, color-mix(in srgb, var(--popover) var(--glass-opacity), transparent))",
  borderColor: "var(--update-foreground)",
};

function updateActionErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function toastUpdateError(title: string, description: string) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description,
    }),
  );
}

function toastFailedUpdateAction(title: string, result: DesktopUpdateActionResult) {
  if (!shouldToastDesktopUpdateActionResult(result)) return;
  const actionError = getDesktopUpdateActionError(result);
  if (!actionError) return;
  toastUpdateError(title, actionError);
}

function startDownloadUpdate(bridge: DesktopBridge, onDone: () => void) {
  void bridge
    .downloadUpdate()
    .then((result) => {
      if (result.completed) {
        showDesktopUpdateDownloadedToast(bridge, result.state);
      }
      toastFailedUpdateAction("Could not download update", result);
    })
    .catch((error) => {
      toastUpdateError(
        "Could not start update download",
        updateActionErrorMessage(error, "An unexpected error occurred."),
      );
    })
    .finally(onDone);
}

function startInstallUpdate(bridge: DesktopBridge, onDone: () => void) {
  void bridge
    .installUpdate()
    .then((result) => {
      toastFailedUpdateAction("Could not install update", result);
    })
    .catch((error) => {
      toastUpdateError(
        "Could not install update",
        updateActionErrorMessage(error, "An unexpected error occurred."),
      );
    })
    .finally(onDone);
}

function startCheckForUpdate(bridge: DesktopBridge, onDone: () => void) {
  void bridge
    .checkForUpdate()
    .then((result) => {
      if (result.checked) return;
      toastUpdateError(
        "Could not check for updates",
        result.state.message ?? "Automatic updates are not available in this build.",
      );
    })
    .catch((error) => {
      toastUpdateError(
        "Could not check for updates",
        updateActionErrorMessage(error, "Update check failed."),
      );
    })
    .finally(onDone);
}

function getSidebarUpdateTooltip(state: DesktopUpdateState | null, isUpdateState: boolean) {
  if (isUpdateState) {
    return state ? getDesktopUpdateButtonTooltip(state) : "Update available";
  }
  if (state?.status === "checking") {
    return "Checking for updates…";
  }
  return "Check for updates";
}

/** Track around the update button. `percent` is 0–100; SVG `pathLength` makes dashoffset a percentage. */
function DownloadProgressRing({ percent }: { readonly percent: number }) {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full -rotate-90"
      viewBox="0 0 32 32"
    >
      <circle
        cx="16"
        cy="16"
        r="14.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.2"
      />
      <circle
        cx="16"
        cy="16"
        r="14.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        pathLength="100"
        strokeDasharray="100 100"
        strokeDashoffset={100 - percent}
        strokeLinecap="round"
        className="transition-[stroke-dashoffset] duration-300 ease-out"
      />
    </svg>
  );
}

function keyReleaseNoteItems(items: ReadonlyArray<string>) {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const occurrence = occurrences.get(item) ?? 0;
    occurrences.set(item, occurrence + 1);
    return { item, key: JSON.stringify([item, occurrence]) };
  });
}

function SidebarUpdateReleaseNotesTooltip({
  state,
  tooltip,
}: {
  readonly state: DesktopUpdateState;
  readonly tooltip: string;
}) {
  if (state.channel !== "nightly" || state.releaseNotes.length === 0) {
    return <>{tooltip}</>;
  }

  return (
    <div className="w-fit max-w-[min(24rem,calc(100vw-2rem))] text-left">
      <div className="px-1">
        {state.status === "available" ? (
          <div>
            <div className="whitespace-nowrap text-sm leading-5 font-medium">
              Update ready to download
            </div>
            {state.availableVersion ? (
              <div className="mt-0.5 text-xs leading-4 text-update-foreground">
                {state.availableVersion}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="text-sm leading-5 font-medium">{tooltip}</div>
        )}
      </div>
      <div className="max-h-[min(28rem,calc(100vh-6rem))] overflow-y-auto px-1 pt-4 pb-1">
        {state.releaseNotes.map((releaseNote, index) => (
          <div key={releaseNote.version}>
            {index > 0 && <Separator className="my-3 bg-border/60" />}
            <section>
              <h3 className="text-foreground text-xs leading-4 font-semibold">
                {index === 0 ? "What's changed" : `Changes in ${releaseNote.version}`}
              </h3>
              <ul className="mt-2 space-y-1.5 pl-4 text-xs leading-5 text-popover-foreground/90">
                {keyReleaseNoteItems(releaseNote.items).map(({ item, key }) => (
                  <li className="list-disc wrap-break-word" key={key}>
                    {item}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SidebarUpdateArchitectureWarning() {
  return isElectron ? <SidebarUpdateArchitectureWarningContent /> : null;
}

function SidebarUpdateArchitectureWarningContent() {
  const state = useDesktopUpdateState();
  const visible = shouldShowArm64IntelBuildWarning(state);
  const description = state && visible ? getArm64IntelBuildWarningDescription(state) : null;

  if (!visible || !description) return null;

  return (
    <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8 text-xs">
      <TriangleAlertIcon />
      <AlertTitle>Intel build on Apple Silicon</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}

export function SidebarUpdatePill() {
  return isElectron ? <SidebarUpdateControl /> : null;
}

function SidebarUpdateControl() {
  const state = useDesktopUpdateState();
  const [isActionPending, setIsActionPending] = useState(false);

  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const isDownloading = state?.status === "downloading";
  const downloadPercent = Math.max(0, Math.min(100, state?.downloadPercent ?? 0));
  const isUpdateState = action !== "none" || isDownloading;
  const tooltip = getSidebarUpdateTooltip(state, isUpdateState);
  const disabled = isUpdateState ? isDesktopUpdateButtonDisabled(state) : !canCheckForUpdate(state);
  const showNightlyReleaseNotes =
    isUpdateState && state?.channel === "nightly" && state.releaseNotes.length > 0;

  const handleAction = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge || !state) return;
    if (disabled || isActionPending) return;

    setIsActionPending(true);
    const clearPending = () => setIsActionPending(false);

    if (action === "download") {
      startDownloadUpdate(bridge, clearPending);
      return;
    }

    if (action === "install") {
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(state, navigator.platform),
        );
      } catch (error) {
        clearPending();
        toastUpdateError(
          "Could not confirm update",
          updateActionErrorMessage(error, "Update confirmation failed."),
        );
        return;
      }
      if (!confirmed) {
        clearPending();
        return;
      }
      startInstallUpdate(bridge, clearPending);
      return;
    }

    startCheckForUpdate(bridge, clearPending);
  }, [action, disabled, isActionPending, state]);

  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={tooltip}
              aria-disabled={disabled || isActionPending || undefined}
              disabled={disabled || isActionPending}
              className={cn(
                "relative inline-flex size-8 items-center justify-center rounded-full outline-hidden ring-ring transition-colors enabled:cursor-pointer focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60",
                isUpdateState
                  ? "bg-update-surface text-update-foreground enabled:hover:bg-update/12"
                  : "text-(--sidebar-icon-color) enabled:hover:bg-sidebar-row-hover enabled:hover:text-sidebar-foreground",
              )}
              onClick={handleAction}
            >
              {isDownloading ? <DownloadProgressRing percent={downloadPercent} /> : null}

              {action === "install" ? (
                <RotateCwIcon className="size-4" />
              ) : isUpdateState ? (
                <DownloadIcon className="size-4" />
              ) : (
                <RefreshCwIcon
                  className={cn("size-4", state?.status === "checking" && "animate-spin")}
                />
              )}
            </button>
          }
        />
        <TooltipPopup
          align="center"
          className={
            showNightlyReleaseNotes
              ? // pointer-events-auto overrides the positioner's pointer-events-none so the
                // release notes stay open (and scrollable) when the cursor moves into them.
                "pointer-events-auto max-w-none text-balance"
              : undefined
          }
          side="top"
          style={isUpdateState ? UPDATE_AVAILABLE_TOOLTIP_STYLE : undefined}
          variant={isUpdateState ? "glass" : "default"}
        >
          {isUpdateState && state ? (
            <SidebarUpdateReleaseNotesTooltip state={state} tooltip={tooltip} />
          ) : (
            tooltip
          )}
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

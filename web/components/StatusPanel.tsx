import { useEffect, useRef, useState } from "preact/hooks";
import type { PingResult, StatusEntry } from "../lib/types.js";
import { pingEndpoint } from "../lib/api.js";
import { runConcurrent } from "../lib/concurrency.js";
import { PROTOCOL_LABEL, fmtMs, fmtTime } from "../lib/format.js";
import { maskKey } from "../lib/storage.js";
import { PROTOCOL_TO_APP } from "../lib/ccswitch.js";
import { useI18n } from "../lib/i18n.js";
import { CcSwitchButton } from "./CcSwitchButton.js";

interface Props {
  entries: StatusEntry[];
  persisted: boolean;
  onDelete: (ids: string[]) => void;
  onGotoTest: (entry: StatusEntry) => void;
  onLaunched: (msg: string) => void;
}

type PingState = {
  status: "idle" | "pinging" | "done";
  result?: PingResult;
  ts?: number;
};

const AUTO_OPTIONS = [0, 10, 30, 60, 300] as const;

function latencyClass(result?: PingResult): string {
  if (!result) return "idle";
  if (!result.ok) return "bad";
  if (result.latencyMs < 500) return "good";
  if (result.latencyMs < 1500) return "ok";
  return "slow";
}

export function StatusPanel({ entries, persisted, onDelete, onGotoTest, onLaunched }: Props) {
  const { t } = useI18n();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [pings, setPings] = useState<Record<string, PingState>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [autoSec, setAutoSec] = useState<number>(0);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);

  const allChecked = entries.length > 0 && entries.every((entry) => checked.has(entry.id));
  const someChecked = checked.size > 0;

  const refresh = async (targets: StatusEntry[]) => {
    if (busyRef.current || targets.length === 0) return;
    const controller = new AbortController();
    busyRef.current = true;
    abortRef.current = controller;
    setBusy(true);
    setProgress({ completed: 0, total: targets.length });
    setPings((prev) => {
      const next = { ...prev };
      for (const entry of targets) {
        next[entry.id] = { ...next[entry.id], status: "pinging" };
      }
      return next;
    });

    try {
      await runConcurrent(
        targets,
        3,
        controller.signal,
        async (entry, signal) => {
          const result = await pingEndpoint({
            protocol: entry.protocol,
            baseUrl: entry.baseUrl,
            isFullUrl: entry.isFullUrl,
            apiKey: entry.apiKey,
            model: entry.model,
            userAgent: entry.userAgent,
          }, signal);
          if (signal.aborted) return;
          setPings((prev) => ({
            ...prev,
            [entry.id]: { status: "done", result, ts: Date.now() },
          }));
        },
        () => setProgress((prev) => ({ ...prev, completed: prev.completed + 1 })),
      );
    } catch (e: any) {
      if (!controller.signal.aborted) {
        onLaunched(t("status.refreshFailed", { msg: e?.message ?? e }));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      busyRef.current = false;
      setBusy(false);
    }
  };

  const selectedEntries = () => entries.filter((entry) => checked.has(entry.id));
  const toggleAll = () => {
    setChecked(allChecked ? new Set() : new Set(entries.map((entry) => entry.id)));
  };

  useEffect(() => {
    const ids = new Set(entries.map((entry) => entry.id));
    setChecked((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setPings((prev) => {
      const next: Record<string, PingState> = {};
      for (const id of Object.keys(prev)) {
        if (ids.has(id)) next[id] = prev[id];
      }
      return next;
    });
  }, [entries]);

  useEffect(() => {
    if (!autoSec) return;
    const timer = setInterval(() => {
      if (!busyRef.current && entries.length > 0) void refresh(entries);
    }, autoSec * 1000);
    return () => clearInterval(timer);
  }, [autoSec, entries]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <section class="panel">
      <h2>{t("status.title")}</h2>
      {!persisted ? <div class="hint fail status-memory">{t("status.memoryOnly")}</div> : null}

      <div class="status-toolbar">
        <button class="primary" disabled={busy || !someChecked} onClick={() => refresh(selectedEntries())}>
          {t("status.refreshSelected")}
        </button>
        {busy ? <button class="danger" onClick={() => abortRef.current?.abort()}>{t("common.cancel")}</button> : null}
        <button disabled={busy || entries.length === 0} onClick={() => refresh(entries)}>
          {t("status.refreshAll")}
        </button>
        <button disabled={busy || entries.length === 0} onClick={toggleAll}>
          {allChecked ? t("common.deselectAll") : t("common.selectAll")}
        </button>
        <button class="danger" disabled={busy || !someChecked} onClick={() => onDelete([...checked])}>
          {t("status.deleteSelected")}
        </button>
        <label class="status-auto">
          <span>{t("status.autoRefresh")}</span>
          <select value={String(autoSec)} disabled={busy} onChange={(e) => setAutoSec(Number((e.target as HTMLSelectElement).value))}>
            {AUTO_OPTIONS.map((sec) => <option value={String(sec)}>{t(`status.auto${sec}`)}</option>)}
          </select>
        </label>
      </div>

      {busy ? (
        <div class="batch-progress" aria-live="polite">
          <div class="batch-progress-label">
            <span>{t("models.progress", progress)}</span>
            <span>{Math.round((progress.completed / Math.max(1, progress.total)) * 100)}%</span>
          </div>
          <progress max={Math.max(1, progress.total)} value={progress.completed} aria-label={t("models.progress", progress)} />
        </div>
      ) : null}

      {entries.length === 0 ? (
        <div class="empty">{t("status.empty")}</div>
      ) : (
        <table class="models status-table">
          <thead>
            <tr>
              <th aria-label={t("common.selectAll")} />
              <th>{t("status.colProvider")}</th>
              <th>{t("status.colModel")}</th>
              <th>{t("status.colLatency")}</th>
              <th>{t("status.colKind")}</th>
              <th>{t("status.colCheckedAt")}</th>
              <th>{t("status.colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const ping = pings[entry.id] ?? { status: "idle" as const };
              const result = ping.result;
              const level = latencyClass(result);
              const title = result?.error ? result.error : result ? `HTTP ${result.status}` : t("status.notChecked");
              return (
                <tr key={entry.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={checked.has(entry.id)}
                      onChange={(e) => {
                        const on = (e.target as HTMLInputElement).checked;
                        setChecked((prev) => {
                          const next = new Set(prev);
                          if (on) next.add(entry.id);
                          else next.delete(entry.id);
                          return next;
                        });
                      }}
                      aria-label={entry.model}
                    />
                  </td>
                  <td>
                    <div class="status-provider">{entry.providerName || t("common.custom")}</div>
                    <div class="url-cell" title={entry.baseUrl}>{entry.baseUrl}</div>
                    <div class="mask">{maskKey(entry.apiKey)}</div>
                  </td>
                  <td>
                    <div class="status-model">{entry.model}</div>
                    <span class="proto-tag">{PROTOCOL_LABEL[entry.protocol]}</span>
                  </td>
                  <td>
                    {ping.status === "pinging" ? (
                      <span class="pbadge testing">{t("status.pinging")}</span>
                    ) : (
                      <span class={"pbadge " + level} title={title}>
                        {result ? fmtMs(result.latencyMs) : t("common.dash")}
                      </span>
                    )}
                  </td>
                  <td>{result ? t(result.kind === "models" ? "status.kindModels" : "status.kindCompletion") : t("common.dash")}</td>
                  <td class="num">{ping.ts ? fmtTime(ping.ts) : t("common.dash")}</td>
                  <td>
                    <div class="status-actions">
                      <button type="button" class="icon" onClick={() => onGotoTest(entry)}>
                        {t("status.gotoTest")}
                      </button>
                      <CcSwitchButton
                        name={`${entry.providerName || t("common.custom")} - ${entry.model}`}
                        endpoint={entry.baseUrl}
                        apiKey={entry.apiKey}
                        model={entry.model}
                        defaultApp={PROTOCOL_TO_APP[entry.protocol]}
                        onLaunched={onLaunched}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

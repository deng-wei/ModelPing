import { useEffect, useState } from "preact/hooks";
import type { Defaults, PresetsResponse, ProviderPreset } from "../lib/types.js";
import { normalizePresets } from "../lib/presets.js";
import { useI18n } from "../lib/i18n.js";

interface Props {
  providers: ProviderPreset[];
  defaults: Defaults;
  busy: boolean;
  onChange: (providers: ProviderPreset[]) => void;
  onImport: (presets: PresetsResponse) => void;
}

const cloneProvider = (p: ProviderPreset): ProviderPreset => ({
  ...p,
  models: p.models.map((m) => ({ ...m })),
});

const emptyProvider = (used: Set<string>): ProviderPreset => {
  let i = 1;
  while (used.has(`provider-${i}`)) i++;
  return {
    id: `provider-${i}`,
    name: `Provider ${i}`,
    baseUrl: "https://api.example.com/v1",
    models: [],
  };
};

function downloadJson(presets: PresetsResponse) {
  const blob = new Blob([JSON.stringify(presets, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `llm-test-presets-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function SettingsPanel({ providers, defaults, busy, onChange, onImport }: Props) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState(providers[0]?.id ?? "");
  const [draft, setDraft] = useState<ProviderPreset | null>(providers[0] ? cloneProvider(providers[0]) : null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const nextId = providers.some((p) => p.id === selectedId) ? selectedId : (providers[0]?.id ?? "");
    if (nextId !== selectedId) setSelectedId(nextId);
    const selected = providers.find((p) => p.id === nextId);
    setDraft(selected ? cloneProvider(selected) : null);
  }, [providers, selectedId]);

  const applyProviders = (nextProviders: ProviderPreset[], nextSelectedId?: string) => {
    try {
      const normalized = normalizePresets({ providers: nextProviders, defaults });
      onChange(normalized.providers);
      setSelectedId(nextSelectedId ?? normalized.providers[0]?.id ?? "");
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  const addProvider = () => {
    const next = emptyProvider(new Set(providers.map((p) => p.id)));
    applyProviders([...providers, next], next.id);
  };

  const saveProvider = () => {
    if (!draft) return;
    try {
      const exists = providers.some((p) => p.id === selectedId);
      const cleaned = normalizePresets({ providers: [draft], defaults }).providers[0];
      const next = exists
        ? providers.map((p) => (p.id === selectedId ? cleaned : p))
        : [...providers, cleaned];
      applyProviders(next, cleaned.id);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  const deleteProvider = () => {
    if (!draft) return;
    if (!confirm(t("settings.confirmDelete", { name: draft.name }))) return;
    applyProviders(providers.filter((p) => p.id !== selectedId));
  };

  const updateDraft = (patch: Partial<ProviderPreset>) => {
    setDraft((p) => (p ? { ...p, ...patch } : p));
  };

  const updateModel = (idx: number, patch: Partial<ProviderPreset["models"][number]>) => {
    setDraft((p) => p ? {
      ...p,
      models: p.models.map((m, i) => (i === idx ? { ...m, ...patch } : m)),
    } : p);
  };

  const removeModel = (idx: number) => {
    setDraft((p) => p ? { ...p, models: p.models.filter((_, i) => i !== idx) } : p);
  };

  const importFile = async (file: File | null) => {
    if (!file) return;
    try {
      const parsed = normalizePresets(JSON.parse(await file.text()));
      onImport(parsed);
      setSelectedId(parsed.providers[0]?.id ?? "");
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  return (
    <section class="panel settings-panel">
      <h2>{t("settings.title")}</h2>
      <div class="settings-toolbar">
        <span class="status-text">{t("settings.toolbarHint")}</span>
        <span class="spacer" />
        <button disabled={busy || providers.length === 0} onClick={() => downloadJson({ providers, defaults })}>{t("settings.exportConfig")}</button>
        <label class={"button-like" + (busy ? " disabled" : "")}>
          {t("settings.importConfig")}
          <input
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              importFile(input.files?.[0] ?? null);
              input.value = "";
            }}
          />
        </label>
      </div>

      {error ? <div class="status-text fail settings-error">{error}</div> : null}

      <div class="settings-layout">
        <div class="provider-list">
          {providers.length === 0 ? (
            <div class="empty">{t("settings.emptyProviders")}</div>
          ) : providers.map((p) => (
            <button
              type="button"
              class={"provider-card " + (p.id === selectedId ? "active" : "")}
              disabled={busy}
              onClick={() => setSelectedId(p.id)}
            >
              {p.name}
            </button>
          ))}
          <button type="button" disabled={busy} onClick={addProvider}>{t("settings.addProvider")}</button>
        </div>

        <div class="settings-form">
          {draft ? (
            <>
              <div class="settings-grid">
                <div class="field">
                  <label>{t("settings.id")}</label>
                  <input class="mono" value={draft.id} onInput={(e) => updateDraft({ id: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="field">
                  <label>{t("settings.name")}</label>
                  <input value={draft.name} onInput={(e) => updateDraft({ name: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="field full">
                  <label>{t("settings.baseUrl")}</label>
                  <input class="mono" value={draft.baseUrl} onInput={(e) => updateDraft({ baseUrl: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="field full">
                  <label class="toggle">
                    <input
                      type="checkbox"
                      checked={Boolean(draft.isFullUrl)}
                      onChange={(e) => updateDraft({ isFullUrl: (e.target as HTMLInputElement).checked })}
                    />
                    {t("settings.baseUrlIsFull")}
                  </label>
                </div>
                <div class="field">
                  <label>{t("settings.keyHint")}</label>
                  <input value={draft.keyHint ?? ""} onInput={(e) => updateDraft({ keyHint: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="field">
                  <label>{t("settings.docs")}</label>
                  <input class="mono" value={draft.docs ?? ""} onInput={(e) => updateDraft({ docs: (e.target as HTMLInputElement).value })} />
                </div>
              </div>

              <div class="models-editor">
                <div class="models-editor-head">
                  <label>{t("settings.models")}</label>
                  <button type="button" disabled={busy} onClick={() => updateDraft({ models: [...draft.models, { id: "" }] })}>{t("settings.addModel")}</button>
                </div>
                {draft.models.length === 0 ? (
                  <div class="empty">{t("settings.emptyModels")}</div>
                ) : draft.models.map((m, idx) => (
                  <div class="model-edit-row" key={idx}>
                    <input
                      class="mono"
                      placeholder={t("settings.modelIdPlaceholder")}
                      value={m.id}
                      onInput={(e) => updateModel(idx, { id: (e.target as HTMLInputElement).value })}
                    />
                    <input
                      placeholder={t("settings.modelLabelPlaceholder")}
                      value={m.label ?? ""}
                      onInput={(e) => updateModel(idx, { label: (e.target as HTMLInputElement).value })}
                    />
                    <button class="icon" type="button" title={t("settings.removeModel")} disabled={busy} onClick={() => removeModel(idx)}>✕</button>
                  </div>
                ))}
              </div>

              <div class="actions">
                <button class="primary" disabled={busy} onClick={saveProvider}>{t("settings.saveProvider")}</button>
                <button disabled={busy} onClick={deleteProvider}>{t("settings.deleteProvider")}</button>
              </div>
            </>
          ) : (
            <div class="empty">{t("settings.selectOrAdd")}</div>
          )}
        </div>
      </div>
    </section>
  );
}

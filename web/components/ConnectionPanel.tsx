import { useState } from "preact/hooks";
import type { Balance, ProviderPreset } from "../lib/types.js";
import { CUSTOM_PROVIDER_ID } from "../lib/presets.js";
import { fetchBalance, fetchModels } from "../lib/api.js";
import { CopyButton } from "./CopyButton.js";
import { ModelPickerModal } from "./ModelPickerModal.js";
import { useI18n, translate, type Lang } from "../lib/i18n.js";

export interface ConnValue {
  providerId: string;
  baseUrl: string;
  isFullUrl?: boolean;
  apiKey: string;
}

interface Props {
  providers: ProviderPreset[];
  value: ConnValue;
  userAgent?: string;
  onChange: (v: ConnValue) => void;
  onAddModels: (ids: string[]) => void;
  onToast: (msg: string) => void;
}

// 余额展示文案。
function fmtBalance(b: Balance, lang: Lang): string {
  const tr = (k: string, p?: Record<string, string | number>) => translate(lang, k, p);
  if (!b.supported) return tr("conn.balanceUnsupported");
  const unit = b.currency ? ` ${b.currency}` : "";
  if (b.remaining != null) {
    const extra = b.total != null && b.used != null ? tr("conn.balanceExtra", { total: b.total, used: b.used }) : "";
    const invalid = b.isValid === false ? tr("conn.balanceInvalid") : "";
    return tr("conn.balanceLine", { remaining: b.remaining, unit, extra, invalid });
  }
  return tr("conn.balanceNotParsed");
}

// 连接面板：点选供应商自动填 baseUrl；或选「自定义」自填。
// key 掩码显示，可切换明文，带复制按钮；并支持查询余额 / 拉取模型列表。
export function ConnectionPanel({ providers, value, userAgent, onChange, onAddModels, onToast }: Props) {
  const { t, lang } = useI18n();
  const [showKey, setShowKey] = useState(false);
  const [balanceBusy, setBalanceBusy] = useState(false);
  const [balanceText, setBalanceText] = useState<string | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [pickerModels, setPickerModels] = useState<string[] | null>(null);

  const canLookup = Boolean(value.baseUrl && value.apiKey);

  const onQueryBalance = async () => {
    if (!canLookup || balanceBusy) return;
    setBalanceBusy(true);
    setBalanceText(t("conn.querying"));
    try {
      const b = await fetchBalance({ baseUrl: value.baseUrl, isFullUrl: value.isFullUrl, apiKey: value.apiKey, userAgent });
      setBalanceText(fmtBalance(b, lang));
    } catch (e: any) {
      setBalanceText(t("conn.queryFailed", { msg: e?.message ?? e }));
    } finally {
      setBalanceBusy(false);
    }
  };

  const onFetchModels = async () => {
    if (!canLookup || modelsBusy) return;
    setModelsBusy(true);
    try {
      const { models } = await fetchModels({ baseUrl: value.baseUrl, isFullUrl: value.isFullUrl, apiKey: value.apiKey, userAgent });
      if (!models.length) {
        onToast(t("conn.noModelsFetched"));
        return;
      }
      setPickerModels(models);
    } catch (e: any) {
      onToast(t("conn.fetchModelsFailed", { msg: e?.message ?? e }));
    } finally {
      setModelsBusy(false);
    }
  };

  const onProvider = (id: string) => {
    if (id === CUSTOM_PROVIDER_ID) {
      onChange({ ...value, providerId: CUSTOM_PROVIDER_ID });
      return;
    }
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    // 切供应商：自动带出 baseUrl，保留已填 key。协议由自动检测决定，不在此设置。
    onChange({ providerId: id, baseUrl: p.baseUrl, isFullUrl: Boolean(p.isFullUrl), apiKey: value.apiKey });
  };

  return (
    <section class="panel">
      <h2>{t("conn.title")}</h2>
      <div class="field">
        <label>{t("conn.provider")}</label>
        <div class="provider-grid">
          <button
            type="button"
            class={"provider-card " + (value.providerId === CUSTOM_PROVIDER_ID ? "active" : "")}
            onClick={() => onProvider(CUSTOM_PROVIDER_ID)}
          >
            {t("common.custom")}
          </button>
          {providers.map((p) => (
            <button
              type="button"
              class={"provider-card " + (value.providerId === p.id ? "active" : "")}
              onClick={() => onProvider(p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div class="row" style="margin-top:12px">
        <div class="field grow">
          <label>{t("conn.baseUrl")}</label>
          <div class="key-wrap">
            <input
              class="mono"
              value={value.baseUrl}
              placeholder="https://api.example.com/v1"
              onInput={(e) => onChange({ ...value, baseUrl: (e.target as HTMLInputElement).value })}
            />
            <CopyButton value={value.baseUrl} title={t("conn.copyBaseUrl")} />
          </div>
          <div class="field-tools">
            <label class="toggle">
              <input
                type="checkbox"
                checked={Boolean(value.isFullUrl)}
                onChange={(e) => onChange({ ...value, isFullUrl: (e.target as HTMLInputElement).checked })}
              />
              {t("conn.fullUrl")}
            </label>
          </div>
        </div>
      </div>

      <div class="row" style="margin-top:12px">
        <div class="field grow">
          <label>API Key</label>
          <div class="key-wrap">
            <input
              class="mono"
              type={showKey ? "text" : "password"}
              value={value.apiKey}
              placeholder={t("conn.apiKeyPlaceholder")}
              autocomplete="off"
              onInput={(e) => onChange({ ...value, apiKey: (e.target as HTMLInputElement).value })}
            />
            <button class="icon" title={showKey ? t("conn.hide") : t("conn.show")} onClick={() => setShowKey((s) => !s)}>
              {showKey ? t("conn.hide") : t("conn.show")}
            </button>
            <CopyButton value={value.apiKey} title={t("conn.copyKey")} />
          </div>
          <div class="field-tools">
            <button
              class="icon"
              title={t("conn.b64Title")}
              onClick={(e) => {
                e.stopPropagation();
                try {
                  const decoded = new TextDecoder().decode(
                    Uint8Array.from(atob(value.apiKey), (c) => c.charCodeAt(0)),
                  );
                  onChange({ ...value, apiKey: decoded });
                } catch {
                  // 非法 base64 或空值:静默不改
                }
              }}
            >
              B64
            </button>
            <button
              class="icon"
              title={t("conn.hexTitle")}
              onClick={(e) => {
                e.stopPropagation();
                try {
                  const bytes = value.apiKey
                    .trim()
                    .split(/\s+/)
                    .filter(Boolean)
                    .map((h) => {
                      if (!/^[0-9a-fA-F]{1,2}$/.test(h)) throw new Error("bad hex");
                      return parseInt(h, 16);
                    });
                  if (bytes.length === 0) return;
                  const decoded = new TextDecoder().decode(Uint8Array.from(bytes));
                  onChange({ ...value, apiKey: decoded });
                } catch {
                  // 非法 hex:静默不改
                }
              }}
            >
              Hex
            </button>
            <button
              class="icon"
              title={t("conn.reverseTitle")}
              onClick={(e) => {
                e.stopPropagation();
                onChange({ ...value, apiKey: Array.from(value.apiKey).reverse().join("") });
              }}
            >
              {t("conn.reverse")}
            </button>
            <span class="field-tools-sep" />
            <button
              class="icon"
              title={t("conn.queryBalanceTitle")}
              disabled={!canLookup || balanceBusy}
              onClick={(e) => { e.stopPropagation(); onQueryBalance(); }}
            >
              {t("conn.queryBalance")}
            </button>
            <button
              class="icon"
              title={t("conn.fetchModelsTitle")}
              disabled={!canLookup || modelsBusy}
              onClick={(e) => { e.stopPropagation(); onFetchModels(); }}
            >
              {modelsBusy ? t("conn.fetchingModels") : t("conn.fetchModels")}
            </button>
          </div>
          {balanceText ? <div class="balance-line">{balanceText}</div> : null}
        </div>
      </div>

      {pickerModels ? (
        <ModelPickerModal
          models={pickerModels}
          onConfirm={(ids) => { onAddModels(ids); onToast(t("conn.addedModels", { count: ids.length })); }}
          onClose={() => setPickerModels(null)}
        />
      ) : null}
    </section>
  );
}

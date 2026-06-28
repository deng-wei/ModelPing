import type { ConfigState } from "../lib/types.js";
import { useI18n } from "../lib/i18n.js";
import { USER_AGENT_PRESETS, isValidUserAgentHeader } from "../lib/user-agent.js";

interface Props {
  value: ConfigState;
  onChange: (v: ConfigState) => void;
}

// 参数面板：输入文本、流式开关、超时、重试、maxTokens。缺省值由上层注入。
export function ConfigPanel({ value, onChange }: Props) {
  const { t } = useI18n();
  const uaPresetValues = new Set<string>(USER_AGENT_PRESETS.map((p) => p.value));
  const selectedUserAgent = uaPresetValues.has(value.userAgent) ? value.userAgent : "__custom__";
  const userAgentInvalid = !isValidUserAgentHeader(value.userAgent);

  const numField = (key: keyof ConfigState, label: string, min: number, max: number, step = 1) => (
    <div class="field">
      <label>{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value[key] as number}
        onInput={(e) => {
          const n = Number((e.target as HTMLInputElement).value);
          onChange({ ...value, [key]: Number.isFinite(n) ? n : value[key] });
        }}
      />
    </div>
  );

  return (
    <section class="panel">
      <h2>{t("config.title")}</h2>
      <div class="config-grid">
        <div class="field full">
          <label>{t("config.input")}</label>
          <textarea
            rows={2}
            value={value.input}
            onInput={(e) => onChange({ ...value, input: (e.target as HTMLTextAreaElement).value })}
          />
        </div>
        {numField("timeoutMs", t("config.timeoutMs"), 1000, 600000, 1000)}
        {numField("maxRetries", t("config.maxRetries"), 0, 10)}
        {numField("maxTokens", t("config.maxTokens"), 1, 200000)}
        {numField("concurrency", t("config.concurrency"), 1, 10)}
        <div class="field">
          <label>{t("config.userAgent")}</label>
          <select
            value={selectedUserAgent}
            onChange={(e) => {
              const next = (e.target as HTMLSelectElement).value;
              if (next !== "__custom__") onChange({ ...value, userAgent: next });
            }}
          >
            {USER_AGENT_PRESETS.map((p) => <option value={p.value}>{t(p.labelKey)}</option>)}
            <option value="__custom__">{t("config.userAgentCustomOption")}</option>
          </select>
        </div>
        <div class="field full">
          <label>{t("config.userAgentCustom")}</label>
          <input
            class={"mono " + (userAgentInvalid ? "invalid" : "")}
            value={value.userAgent}
            placeholder={t("config.userAgentPlaceholder")}
            onInput={(e) => onChange({ ...value, userAgent: (e.target as HTMLInputElement).value })}
          />
          <div class={"hint " + (userAgentInvalid ? "fail" : "")}>
            {userAgentInvalid ? t("config.userAgentInvalid") : t("config.userAgentHint")}
          </div>
        </div>
      </div>
    </section>
  );
}

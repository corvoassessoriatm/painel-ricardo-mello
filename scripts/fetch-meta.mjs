// fetch-meta.mjs — puxa a Meta Marketing API e reescreve ../data.json
// Rodado pelo GitHub Actions de hora em hora. Node 20+ (fetch global).
// Requer as variáveis de ambiente: META_TOKEN (obrigatória), AD_ACCOUNT_ID (opcional).

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TOKEN = process.env.META_TOKEN;
const ACCOUNT = process.env.AD_ACCOUNT_ID || "2895948854126435";
const API = "https://graph.facebook.com/v21.0";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "data.json");

if (!TOKEN) { console.error("ERRO: defina o secret META_TOKEN."); process.exit(1); }

// ---- HTTP helper com paginação ----
async function getAll(path, params) {
  const url = new URL(`${API}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set("access_token", TOKEN);
  url.searchParams.set("limit", params.limit || "500");
  let out = [], next = url.toString();
  while (next) {
    const r = await fetch(next);
    const j = await r.json();
    if (j.error) throw new Error(`${path}: ${j.error.message}`);
    out = out.concat(j.data || []);
    next = j.paging && j.paging.next ? j.paging.next : null;
  }
  return out;
}

// ---- extrai um evento do array actions[] ----
const num = v => (v == null ? 0 : Math.round(parseFloat(v)));
function pick(actions, types) {
  if (!Array.isArray(actions)) return 0;
  for (const t of types) {
    const hit = actions.find(a => a.action_type === t);
    if (hit) return num(hit.value);
  }
  return 0;
}
function toAct(row) {
  const a = row.actions || [];
  const act = {
    purchase:         pick(a, ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"]),
    lead:             pick(a, ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"]),
    initiate_checkout:pick(a, ["omni_initiated_checkout", "initiate_checkout"]),
    ig_visit:         pick(a, ["onsite_conversion.ig_profile_visit", "onsite_conversion.ig_profile_engagement"]),
    msg:              pick(a, ["onsite_conversion.messaging_conversation_started_7d", "onsite_conversion.total_messaging_connection"]),
    link_click:       pick(a, ["link_click"]),
    thruplay:         pick(row.video_thruplay_watched_actions, ["video_view"]) ||
                      (Array.isArray(row.video_thruplay_watched_actions) ? num(row.video_thruplay_watched_actions[0]?.value) : 0),
  };
  // remove zeros para o JSON ficar enxuto
  Object.keys(act).forEach(k => { if (!act[k]) delete act[k]; });
  return act;
}

const INSIGHT_FIELDS = "spend,impressions,reach,clicks,actions,video_thruplay_watched_actions";

async function main() {
  // 1) status (config, não vem no insights)
  const campMeta = await getAll(`act_${ACCOUNT}/campaigns`, { fields: "id,name,objective,status,effective_status" });
  const adMeta   = await getAll(`act_${ACCOUNT}/ads`,       { fields: "id,name,campaign_id,status,effective_status" });
  const campById = Object.fromEntries(campMeta.map(c => [c.id, c]));
  const adById   = Object.fromEntries(adMeta.map(a => [a.id, a]));

  // 2) insights por campanha (últimos 30 dias)
  const campIns = await getAll(`act_${ACCOUNT}/insights`, { level: "campaign", date_preset: "last_30d", fields: `campaign_id,campaign_name,objective,${INSIGHT_FIELDS}` });
  const campaigns = campIns
    .filter(r => parseFloat(r.spend) > 0)
    .map(r => ({
      id: r.campaign_id,
      name: r.campaign_name,
      objective: r.objective || (campById[r.campaign_id] || {}).objective || "",
      status: (campById[r.campaign_id] || {}).effective_status === "ACTIVE" ? "ACTIVE" : "PAUSED",
      spend: +(+r.spend).toFixed(2), impr: num(r.impressions), reach: num(r.reach), clicks: num(r.clicks),
      act: toAct(r),
    }))
    .sort((a, b) => b.spend - a.spend);

  // 3) insights por anúncio (criativos em execução)
  const adIns = await getAll(`act_${ACCOUNT}/insights`, { level: "ad", date_preset: "last_30d", fields: `ad_id,ad_name,campaign_id,${INSIGHT_FIELDS}` });
  const ads = adIns
    .filter(r => parseFloat(r.spend) > 0)
    .map(r => ({
      id: r.ad_id, name: r.ad_name, campaign_id: r.campaign_id,
      status: (adById[r.ad_id] || {}).effective_status === "ACTIVE" ? "ACTIVE" : "PAUSED",
      spend: +(+r.spend).toFixed(2), impr: num(r.impressions), reach: num(r.reach), clicks: num(r.clicks),
      act: toAct(r),
    }))
    .sort((a, b) => b.spend - a.spend);

  // 4) série diária da conta (90 dias) para a tendência
  const dailyIns = await getAll(`act_${ACCOUNT}/insights`, { level: "account", time_increment: "1", date_preset: "last_90d", fields: "spend,impressions,clicks,reach" });
  const daily = dailyIns.map(r => ({
    d: r.date_start, spend: +(+r.spend).toFixed(2), impr: num(r.impressions), clicks: num(r.clicks), reach: num(r.reach),
  }));

  const acc = campById && Object.values(campById)[0];
  const data = {
    meta: {
      account_id: ACCOUNT,
      account_name: "EXPONENTIAL NOVO 2025",
      client: "Ricardo Mello",
      currency: "BRL",
      period: "last_30d",
      updated_at: new Date().toISOString(),
      seed: false,
    },
    campaigns, ads, daily,
  };
  writeFileSync(OUT, JSON.stringify(data, null, 2) + "\n");
  console.log(`OK · ${campaigns.length} campanhas · ${ads.length} criativos · ${daily.length} dias`);
}

main().catch(e => { console.error("FALHA:", e.message); process.exit(1); });

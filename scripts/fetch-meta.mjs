// fetch-meta.mjs — puxa a Meta Marketing API e reescreve ../data.json (multi-período).
// Rodado pelo GitHub Actions de hora em hora. Node 20+ (fetch global).
// Env: META_TOKEN (obrigatória), AD_ACCOUNT_ID (opcional).

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TOKEN = process.env.META_TOKEN;
const ACCOUNT = process.env.AD_ACCOUNT_ID || "2895948854126435";
const API = "https://graph.facebook.com/v21.0";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "data.json");
const PRESETS = ["today", "yesterday", "last_7d", "last_30d", "last_90d"];

if (!TOKEN) { console.error("ERRO: defina o secret META_TOKEN."); process.exit(1); }

async function getAll(path, params) {
  const url = new URL(`${API}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set("access_token", TOKEN);
  url.searchParams.set("limit", params.limit || "300");
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
const num = v => (v == null ? 0 : Math.round(parseFloat(v)));
function pick(actions, types) {
  if (!Array.isArray(actions)) return 0;
  for (const t of types) { const h = actions.find(a => a.action_type === t); if (h) return num(h.value); }
  return 0;
}
const sumArr = a => Array.isArray(a) ? a.reduce((s, x) => s + num(x.value), 0) : num(a);

const IF = "ad_id,ad_name,adset_id,campaign_id,spend,impressions,reach,clicks,actions,video_thruplay_watched_actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p95_watched_actions";

function toAct(r) {
  const a = r.actions || [];
  const act = {
    pu: pick(a, ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"]),
    le: pick(a, ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"]),
    ck: pick(a, ["omni_initiated_checkout", "initiate_checkout"]),
    ig: pick(a, ["onsite_conversion.ig_profile_visit", "onsite_conversion.ig_profile_engagement"]),
    fo: pick(a, ["onsite_conversion.follow", "onsite_conversion.page_follow", "follow", "like"]),
    lc: pick(a, ["link_click"]),
    tp: sumArr(r.video_thruplay_watched_actions),
  };
  Object.keys(act).forEach(k => { if (!act[k]) delete act[k]; });
  return act;
}
function toVid(r) {
  const h = pick(r.actions, ["video_view"]); // reproduções de 3s
  const tp = sumArr(r.video_thruplay_watched_actions);
  if (!h && !tp) return null;
  return { h, tp,
    q25: sumArr(r.video_p25_watched_actions), q50: sumArr(r.video_p50_watched_actions),
    q75: sumArr(r.video_p75_watched_actions), q95: sumArr(r.video_p95_watched_actions) };
}

async function main() {
  const campMeta = await getAll(`act_${ACCOUNT}/campaigns`, { fields: "id,name,objective,status,effective_status" });
  const adMeta = await getAll(`act_${ACCOUNT}/ads`, { fields: "id,effective_status" });
  const adsetMeta = await getAll(`act_${ACCOUNT}/adsets`, { fields: "id,name" });
  const statusOf = Object.fromEntries(adMeta.map(a => [a.id, a.effective_status === "ACTIVE" ? "ACTIVE" : "PAUSED"]));
  const campById = Object.fromEntries(campMeta.map(c => [c.id, c]));
  const adsetName = Object.fromEntries(adsetMeta.map(s => [s.id, s.name]));

  const periods = {};
  const usedCamps = new Set(), usedAdsets = new Set();
  for (const preset of PRESETS) {
    const rows = await getAll(`act_${ACCOUNT}/insights`, { level: "ad", date_preset: preset, fields: IF });
    const list = rows.filter(r => parseFloat(r.spend) > 0).map(r => {
      usedCamps.add(r.campaign_id); if (r.adset_id) usedAdsets.add(r.adset_id);
      const ad = { id: r.ad_id, name: r.ad_name, campaign_id: r.campaign_id, status: statusOf[r.ad_id] || "PAUSED",
        spend: +(+r.spend).toFixed(2), impr: num(r.impressions), reach: num(r.reach), clicks: num(r.clicks), act: toAct(r) };
      if (r.adset_id) ad.adset_id = r.adset_id;
      const v = toVid(r); if (v) ad.vid = v;
      return ad;
    }).sort((a, b) => b.spend - a.spend);
    periods[preset] = { ads: list };
  }

  const dailyRows = await getAll(`act_${ACCOUNT}/insights`, { level: "account", time_increment: "1", date_preset: "last_90d", fields: "spend,impressions,clicks,reach" });
  const daily = dailyRows.map(r => ({ d: r.date_start, spend: +(+r.spend).toFixed(2), impr: num(r.impressions), clicks: num(r.clicks), reach: num(r.reach) }));

  const campaigns = [...usedCamps].filter(id => campById[id]).map(id => ({ id, name: campById[id].name, objective: campById[id].objective || "" }));
  const adsets = [...usedAdsets].map(id => ({ id, name: adsetName[id] || id }));

  const data = {
    meta: { account_id: ACCOUNT, account_name: "EXPONENTIAL NOVO 2025",
      client: "Ricardo Mello", currency: "BRL", tz: "America/Sao_Paulo", updated_at: new Date().toISOString(), seed: false, default_period: "last_30d" },
    campaigns, adsets, periods, daily,
  };
  writeFileSync(OUT, JSON.stringify(data) + "\n");
  console.log("OK", PRESETS.map(p => p + "=" + periods[p].ads.length).join(" "), "| campaigns", campaigns.length, "| adsets", adsets.length, "| daily", daily.length);
}
main().catch(e => { console.error("FALHA:", e.message); process.exit(1); });

// 日記アプリ用 Edge Function
// Notion の Diary データベースの読み書きと、OpenAI による「過去の自分との対話」の問い生成を行う。
//
// 必要な Secrets（Supabase ダッシュボード → Edge Functions → Secrets）:
//   NOTION_API_KEY      … Notion インテグレーションのキー（ntn_...）
//   NOTION_DATABASE_ID  … Diary データベースの ID
//   OPENAI_API_KEY      … OpenAI のキー（sk-...）
//   ALLOWED_EMAIL       … このアプリを使えるログイン用メールアドレス（自分のもの）
// 任意:
//   OPENAI_MODEL        … 既定は gpt-6-luna（もっと賢くしたいなら gpt-6.1-terra）

import { createClient } from "jsr:@supabase/supabase-js@2";

// Secrets は名前のゆれ（空白・大文字小文字・アンダースコアの有無）に強く読み取る。値の前後の空白や " も取り除く。
const norm = (k: string) => k.toUpperCase().replace(/[^A-Z0-9]/g, "");
function env(name: string, ...aliases: string[]): string {
  const wanted = new Set([name, ...aliases].map(norm));
  for (const [k, v] of Object.entries(Deno.env.toObject())) {
    if (wanted.has(norm(k))) return v.trim().replace(/^["']|["']$/g, "").trim();
  }
  return "";
}
// 設定済みの Secrets の「名前だけ」を返す（値は返さない）。設定ミスの確認用
const customSecretNames = () =>
  Object.keys(Deno.env.toObject())
    .filter((k) => !/^(SUPABASE_|SB_|DENO_|PATH$|HOME$|HOSTNAME$|LANG$|TZ$|PWD$|EDGE_|AWS_|OTEL_)/.test(k))
    .sort();

const NOTION_API_KEY = env("NOTION_API_KEY", "NOTION_KEY", "NOTION_TOKEN");
const NOTION_DATABASE_ID = env("NOTION_DATABASE_ID", "NOTION_DB_ID", "DATABASE_ID").replace(/-/g, "");
const OPENAI_API_KEY = env("OPENAI_API_KEY", "OPENAI_KEY");
const ALLOWED_EMAIL = env("ALLOWED_EMAIL").toLowerCase();
const OPENAI_MODEL = env("OPENAI_MODEL") || "gpt-6-luna";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const MAX_RETRIES = 5;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ── 共通: リトライ付き fetch（429 と 5xx は待って再試行）──
async function fetchWithRetry(url: string, init: RequestInit, label: string) {
  let lastText = "";
  for (let i = 0; i < MAX_RETRIES; i++) {
    const res = await fetch(url, init);
    if (res.ok) return res.json();
    lastText = await res.text();
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2 ** i * 500));
      continue;
    }
    throw new HttpError(502, `${label} エラー (${res.status}): ${lastText.slice(0, 300)}`);
  }
  throw new HttpError(502, `${label} が混み合っています: ${lastText.slice(0, 200)}`);
}

// ── Notion ──
const notionHeaders = () => ({
  "Authorization": `Bearer ${NOTION_API_KEY}`,
  "Content-Type": "application/json",
  "Notion-Version": "2022-06-28",
});

function notion(path: string, method = "GET", body?: unknown) {
  return fetchWithRetry(
    `https://api.notion.com/v1${path}`,
    { method, headers: notionHeaders(), body: body ? JSON.stringify(body) : undefined },
    "Notion",
  );
}

// deno-lint-ignore no-explicit-any
async function queryDiaries(filter: unknown): Promise<any[]> {
  // deno-lint-ignore no-explicit-any
  const all: any[] = [];
  let cursor: string | undefined;
  do {
    // deno-lint-ignore no-explicit-any
    const payload: any = { filter, page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    const data = await notion(`/databases/${NOTION_DATABASE_ID}/query`, "POST", payload);
    all.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return all;
}

// deno-lint-ignore no-explicit-any
function pageDate(page: any): string | null {
  const start = page?.properties?.Date?.date?.start;
  return start ? String(start).slice(0, 10) : null;
}

// ── 日付ヘルパー（"YYYY-MM-DD" をタイムゾーンに左右されずに扱う）──
function parseDate(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, `日付の形式が正しくありません: ${s}`);
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
function monthsBefore(d: Date, n: number): Date {
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() - n; // 0始まり
  while (m < 0) { m += 12; y -= 1; }
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay)));
}

// ── 日記がある日付の一覧（カレンダーの●用）──
async function getDiaryDates(from: string, to: string): Promise<string[]> {
  parseDate(from); parseDate(to);
  const pages = await queryDiaries({
    and: [
      { property: "Date", date: { on_or_after: from } },
      { property: "Date", date: { on_or_before: to } },
    ],
  });
  const set = new Set<string>();
  for (const p of pages) {
    const d = pageDate(p);
    if (d) set.add(d);
  }
  return [...set].sort();
}

// ── 対象日（なければ前日・翌日）の日記を探す ──
async function findDiaryNear(target: Date): Promise<{ id: string; date: string } | null> {
  const pages = await queryDiaries({
    and: [
      { property: "Date", date: { on_or_after: fmt(addDays(target, -1)) } },
      { property: "Date", date: { on_or_before: fmt(addDays(target, 1)) } },
    ],
  });
  const byDate = new Map<string, string>();
  for (const p of pages) {
    const d = pageDate(p);
    if (d && !byDate.has(d)) byDate.set(d, p.id);
  }
  for (const d of [target, addDays(target, -1), addDays(target, 1)]) {
    const id = byDate.get(fmt(d));
    if (id) return { id, date: fmt(d) };
  }
  return null;
}

// ── ページ本文をテキストで取り出す（トグルの中身も含む）──
// deno-lint-ignore no-explicit-any
async function blockChildren(blockId: string): Promise<any[]> {
  // deno-lint-ignore no-explicit-any
  const all: any[] = [];
  let cursor: string | undefined;
  do {
    const q = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
    const data = await notion(`/blocks/${blockId}/children${q}`);
    all.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return all;
}

// deno-lint-ignore no-explicit-any
const plain = (rt: any[] = []) => rt.map((t) => t.plain_text ?? t.text?.content ?? "").join("");

async function pageText(blockId: string, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  const lines: string[] = [];
  for (const b of await blockChildren(blockId)) {
    const body = b[b.type];
    const text = plain(body?.rich_text);
    switch (b.type) {
      case "heading_1": case "heading_2": case "heading_3":
        if (text) lines.push(`【${text}】`);
        break;
      case "bulleted_list_item": case "numbered_list_item": case "to_do":
        if (text) lines.push("・" + text);
        break;
      case "paragraph": case "quote": case "callout":
        if (text) lines.push(text);
        break;
      case "toggle":
        if (text) lines.push(text);
        break;
    }
    if (b.has_children) lines.push(...(await pageText(b.id, depth + 1)));
  }
  return lines;
}

// ── OpenAI ──
// 新しい世代のモデル（gpt-5 以降）は max_tokens / temperature を受け付けないことがあり、
// 内部で「考える」分のトークンも出力枠を使うため、次のようにしている:
//  - 出力の上限は max_completion_tokens で、余裕を持って大きめにとる
//  - temperature は gpt-4 系のときだけ付ける
//  - それでも「このパラメータは使えない」と言われたら、そのパラメータを外して1回だけやり直す
//  - 出力枠が足りずに空で返ってきたら、枠を広げて1回だけやり直す
const isLegacyModel = (m: string) => /^gpt-4/.test(m);

async function chat(prompt: string, answerTokens: number): Promise<string> {
  // deno-lint-ignore no-explicit-any
  const payload: any = {
    model: OPENAI_MODEL,
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: isLegacyModel(OPENAI_MODEL) ? answerTokens : answerTokens + 3000,
  };
  if (isLegacyModel(OPENAI_MODEL)) payload.temperature = 0.8;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await fetchWithRetry(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        "OpenAI",
      );
      const choice = data.choices?.[0];
      const text = String(choice?.message?.content ?? "").trim();
      if (text) return text;
      if (choice?.finish_reason === "length" && attempt < 2) {
        payload.max_completion_tokens *= 2;
        continue;
      }
      throw new HttpError(502, "OpenAI から空の返事が返ってきました");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const bad = msg.match(/(?:Unsupported|unsupported|not supported)[^']*'([a-z_]+)'/);
      if (bad && bad[1] in payload && bad[1] !== "model" && bad[1] !== "messages" && attempt < 2) {
        delete payload[bad[1]];
        continue;
      }
      throw e;
    }
  }
  throw new HttpError(502, "OpenAI から問いを受け取れませんでした");
}

function questionFromDiary(diaryText: string) {
  const prompt = `以下は過去の私の日記の一部です。
- 「その日の出来事」
- 「気持ち・アイデア」
- 「当時の問いに対する自分の回答」(=当時考えていたこと)

この内容を踏まえて、現在の私に対して自己理解や価値観の変化、成長を促すような簡単な問いを1つ考えてください。
問いの条件:
・内省を促す深い問いであること
・考えや感情の変化、成長を感じられるような視点を含むこと
・問いの形式で
・簡潔であること
・問いの文だけを出力すること（前置きや「問い:」などの見出しは不要）

日記内容:
${diaryText}

問い:`;
  return chat(prompt, 300);
}

function randomQuestion() {
  return chat(
    "自己分析を深めるための簡単な質問を1つ作ってください。様々なテーマの中から選んでください。時事ネタを含むことがあってもいいです。質問の文だけを出力してください。",
    200,
  );
}

const cleanQuestion = (q: string) =>
  q.replace(/^\s*(問い|質問)\s*[:：]\s*/, "").replace(/^["「]|["」]$/g, "").trim();

async function buildQuestion(base: Date, months: number) {
  const target = monthsBefore(base, months);
  const found = await findDiaryNear(target);
  if (found) {
    const text = (await pageText(found.id)).join("\n").trim();
    if (text) {
      return { months, sourceDate: found.date, question: cleanQuestion(await questionFromDiary(text)) };
    }
  }
  return { months, sourceDate: null, question: cleanQuestion(await randomQuestion()) };
}

// ── 保存 ──
function richText(text: string, size = 2000) {
  const t = text ?? "";
  const chunks: string[] = [];
  for (let i = 0; i < t.length; i += size) chunks.push(t.slice(i, i + size));
  if (!chunks.length) chunks.push("");
  return chunks.map((c) => ({ type: "text", text: { content: c } }));
}

const heading = (t: string) => ({ object: "block", type: "heading_2", heading_2: { rich_text: richText(t) } });
const paragraph = (t: string) => ({ object: "block", type: "paragraph", paragraph: { rich_text: richText(t) } });

type QA = { question: string; answer: string };

async function saveDiary(input: {
  date: string; events?: string; feelings?: string; tags?: string[]; qa?: QA[];
}) {
  parseDate(input.date);
  const qa = (input.qa ?? []).filter((x) => x && String(x.question ?? "").trim());
  const children: unknown[] = [
    heading("今日の出来事"),
    paragraph(input.events ?? ""),
    heading("気持ち・アイデア"),
    paragraph(input.feelings ?? ""),
    heading("過去の自分との対話"),
  ];
  for (const { question, answer } of qa) {
    children.push({
      object: "block",
      type: "toggle",
      toggle: {
        rich_text: richText(`問い: ${String(question).trim()}`),
        children: [paragraph(`回答: ${answer ?? ""}`)],
      },
    });
  }
  const tags = (input.tags ?? []).map(String).filter(Boolean);
  const page = await notion("/pages", "POST", {
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      Name: { title: [{ type: "text", text: { content: "日記" } }] },
      Date: { date: { start: input.date } },
      Tag: { multi_select: tags.map((name) => ({ name })) },
    },
    children,
  });
  return { ok: true, url: page.url };
}

// ── ログイン確認 ──
async function requireUser(req: Request) {
  if (!ALLOWED_EMAIL) throw new HttpError(500, "ALLOWED_EMAIL が設定されていません");
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "ログインしてください");
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, "ログインの期限が切れました。もう一度ログインしてください");
  if ((data.user.email ?? "").toLowerCase() !== ALLOWED_EMAIL) throw new HttpError(403, "このアカウントでは使えません");
}

function checkConfig(needsOpenAI: boolean) {
  const missing = [];
  if (!NOTION_API_KEY) missing.push("NOTION_API_KEY");
  if (!NOTION_DATABASE_ID) missing.push("NOTION_DATABASE_ID");
  if (needsOpenAI && !OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (missing.length) {
    const names = customSecretNames();
    throw new HttpError(500, `Secrets が未設定です: ${missing.join(", ")}（いま見えている名前: ${names.length ? names.join(", ") : "なし"}）`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    await requireUser(req);
    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case "dates":
        checkConfig(false);
        return json({ dates: await getDiaryDates(body.from, body.to) });
      case "questions": {
        checkConfig(true);
        const base = parseDate(body.date);
        const questions = await Promise.all([buildQuestion(base, 1), buildQuestion(base, 12)]);
        return json({ questions });
      }
      case "save":
        checkConfig(false);
        return json(await saveDiary(body));
      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});

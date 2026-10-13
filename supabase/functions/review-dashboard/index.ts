import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const COOKIE = "chai_review_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;

function supabaseAdmin() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase server credentials unavailable.");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function cookieValue(req: Request, name: string) {
  const header = req.headers.get("cookie") || "";
  for (const piece of header.split(";")) {
    const [key, ...rest] = piece.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function json(status: number, body: unknown, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function page(status: number, html: string, headers: HeadersInit = {}) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'self'; img-src 'self' https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      ...headers,
    },
  });
}

async function getSession(req: Request, supabase: ReturnType<typeof supabaseAdmin>) {
  const raw = cookieValue(req, COOKIE);
  if (!raw) return null;
  const hash = await sha256Hex(raw);
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("dashboard_sessions")
    .select("id,actor,expires_at")
    .eq("token_hash", hash)
    .gt("expires_at", now)
    .maybeSingle();

  if (error || !data) return null;

  await supabase
    .from("dashboard_sessions")
    .update({ last_used_at: now })
    .eq("id", data.id);

  return { ...data, tokenHash: hash };
}

async function validSetupToken(
  setupToken: string,
  supabase: ReturnType<typeof supabaseAdmin>,
) {
  const hash = await sha256Hex(setupToken);
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("dashboard_setup_tokens")
    .select("id")
    .eq("token_hash", hash)
    .is("used_at", null)
    .gt("expires_at", now)
    .maybeSingle();

  return !error && !!data;
}

async function establishSession(
  setupToken: string,
  supabase: ReturnType<typeof supabaseAdmin>,
) {
  const hash = await sha256Hex(setupToken);
  const now = new Date().toISOString();

  const { data: setup, error } = await supabase
    .from("dashboard_setup_tokens")
    .select("id")
    .eq("token_hash", hash)
    .is("used_at", null)
    .gt("expires_at", now)
    .maybeSingle();

  if (error || !setup) return null;

  const { data: consumed, error: consumeError } = await supabase
    .from("dashboard_setup_tokens")
    .update({ used_at: now })
    .eq("id", setup.id)
    .is("used_at", null)
    .select("id")
    .maybeSingle();

  if (consumeError || !consumed) return null;

  const rawSession = randomToken(32);
  const sessionHash = await sha256Hex(rawSession);
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();

  const { error: sessionError } = await supabase
    .from("dashboard_sessions")
    .insert({
      token_hash: sessionHash,
      actor: "mobile-review-dashboard",
      expires_at: expiresAt,
      last_used_at: now,
    });

  if (sessionError) return null;

  return rawSession;
}

async function queueData(supabase: ReturnType<typeof supabaseAdmin>) {
  const { data: packages, error } = await supabase
    .from("content_packages")
    .select(
      "id,edition,content_type,headline,poster_text,caption,render_payload,status,approved_at,created_at,updated_at,image_asset_id",
    )
    .in("status", ["review", "approved"])
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) throw error;

  const packageIds = (packages || []).map((p) => p.id);
  const assetIds = (packages || [])
    .map((p) => p.image_asset_id)
    .filter(Boolean);

  let jobs: any[] = [];
  if (packageIds.length) {
    const { data, error: jobsError } = await supabase
      .from("render_jobs")
      .select(
        "id,content_package_id,status,error_message,canva_design_id,canva_edit_url,canva_view_url,created_at,updated_at",
      )
      .in("content_package_id", packageIds)
      .order("created_at", { ascending: false });
    if (jobsError) throw jobsError;
    jobs = data || [];
  }

  const latestJobByPackage = new Map();
  for (const job of jobs) {
    if (!latestJobByPackage.has(job.content_package_id)) {
      latestJobByPackage.set(job.content_package_id, job);
    }
  }

  const assetById = new Map();
  if (assetIds.length) {
    const { data: assets, error: assetsError } = await supabase
      .from("assets")
      .select("id,storage_bucket,storage_path,mime_type")
      .in("id", assetIds);
    if (assetsError) throw assetsError;

    for (const asset of assets || []) {
      let signedUrl = null;
      const { data: signed } = await supabase.storage
        .from(asset.storage_bucket)
        .createSignedUrl(asset.storage_path, 60 * 15);
      if (signed?.signedUrl) signedUrl = signed.signedUrl;
      assetById.set(asset.id, { ...asset, signed_url: signedUrl });
    }
  }

  return (packages || []).map((pkg) => ({
    ...pkg,
    render_job: latestJobByPackage.get(pkg.id) || null,
    image_asset: pkg.image_asset_id
      ? assetById.get(pkg.image_asset_id) || null
      : null,
  }));
}

const dashboardHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>Chai O'Clock Review</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#171717;background:#f4f2ed}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh}
    header{position:sticky;top:0;z-index:10;background:rgba(244,242,237,.94);backdrop-filter:blur(10px);border-bottom:1px solid #dedbd2;padding:16px 18px}
    .top{max-width:820px;margin:auto;display:flex;align-items:center;justify-content:space-between;gap:16px}
    .brand{font-family:Georgia,serif;font-style:italic;font-weight:700;font-size:24px;letter-spacing:.01em}
    .sub{font-size:12px;color:#6b6860;margin-top:3px}
    main{max-width:820px;margin:0 auto;padding:18px 14px 80px}
    .toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;color:#656159;font-size:13px}
    button{font:inherit;border:0;border-radius:12px;padding:12px 16px;font-weight:700;cursor:pointer}
    .small{padding:8px 10px;background:#e9e6de;color:#36332f}
    .card{background:#fff;border:1px solid #dfdcd5;border-radius:20px;margin:0 0 16px;overflow:hidden;box-shadow:0 4px 18px rgba(0,0,0,.035)}
    .body{padding:18px}
    .meta{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
    .pill{font-size:11px;text-transform:uppercase;letter-spacing:.08em;background:#efede7;border-radius:999px;padding:6px 9px;color:#59564f}
    .pill.review{background:#fff1c7;color:#6a4c00}
    .pill.approved{background:#dff2e4;color:#1d5b2b}
    .pill.failed{background:#f8dddd;color:#7b2020}
    h2{font-family:Georgia,serif;font-size:25px;line-height:1.08;margin:8px 0 8px}
    .poster{font-size:15px;color:#504d47;margin-bottom:14px}
    .fields{border-top:1px solid #eeeae2;border-bottom:1px solid #eeeae2;padding:12px 0;margin:12px 0}
    .field{display:grid;grid-template-columns:110px 1fr;gap:10px;padding:5px 0;font-size:13px}
    .field strong{color:#777269;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
    .caption{white-space:pre-wrap;line-height:1.5;font-size:14px;background:#faf9f6;border-radius:12px;padding:12px}
    img.preview{display:block;width:100%;max-height:620px;object-fit:contain;background:#ece9e2}
    .actions{display:flex;gap:10px;padding:0 18px 18px}
    .approve{background:#171717;color:#fff;flex:1}
    .reject{background:#efece5;color:#6a302b;flex:1}
    .note{width:100%;border:1px solid #ddd8ce;border-radius:12px;padding:11px 12px;margin:0 0 12px;font:inherit}
    .empty{text-align:center;padding:60px 20px;color:#6e6a62}
    .statusline{font-size:12px;color:#767168;margin-top:10px}
    .error{color:#8d2828}
    .success{color:#246030}
    @media(max-width:520px){h2{font-size:22px}.field{grid-template-columns:88px 1fr}.actions{position:sticky;bottom:0;background:#fff;padding-top:12px;border-top:1px solid #eeeae2}}
  </style>
</head>
<body>
<header>
  <div class="top">
    <div><div class="brand">Chai O'Clock</div><div class="sub">Review & approval</div></div>
    <button class="small" onclick="logout()">Log out</button>
  </div>
</header>
<main>
  <div class="toolbar"><span id="summary">Loading…</span><button class="small" onclick="loadQueue()">Refresh</button></div>
  <div id="queue"></div>
</main>
<script>
const esc = (s='') => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
let timer;

function renderStatus(p) {
  const j = p.render_job;
  if (p.status === 'review') return 'Awaiting your decision';
  if (!j) return 'Approved · waiting for render job';
  if (j.status === 'queued') return 'Approved · queued for Canva';
  if (j.status === 'rendering') return 'Approved · rendering in Canva';
  if (j.status === 'rendered') return 'Rendered · ready for staging';
  if (j.status === 'failed') return 'Render failed · ' + (j.error_message || 'needs attention');
  return 'Approved · ' + j.status;
}

function card(p) {
  const payload = p.render_payload || {};
  const fields = Object.entries(payload)
    .filter(([k,v]) => typeof v === 'string' && v.trim())
    .map(([k,v]) => '<div class="field"><strong>'+esc(k.replaceAll('_',' '))+'</strong><span>'+esc(v)+'</span></div>')
    .join('');
  const img = p.image_asset?.signed_url
    ? '<img class="preview" src="'+esc(p.image_asset.signed_url)+'" alt="Rendered poster preview">'
    : '';
  const jobClass = p.render_job?.status === 'failed' ? ' failed' : '';
  const actions = p.status === 'review'
    ? '<div class="body" style="padding-top:0"><input class="note" id="note-'+p.id+'" placeholder="Optional review note"></div><div class="actions"><button class="reject" onclick="decide(\''+p.id+'\',\'reject\')">Reject</button><button class="approve" onclick="decide(\''+p.id+'\',\'approve\')">Approve</button></div>'
    : '<div class="actions"><button class="reject" onclick="decide(\''+p.id+'\',\'reject\')">Remove from approval</button></div>';
  return '<article class="card">'+img+'<div class="body"><div class="meta"><span class="pill '+esc(p.status)+'">'+esc(p.status)+'</span><span class="pill">'+esc(p.edition)+'</span><span class="pill">'+esc(p.content_type)+'</span></div><h2>'+esc(p.headline || 'Untitled package')+'</h2><div class="poster">'+esc(p.poster_text || '')+'</div>'+(fields?'<div class="fields">'+fields+'</div>':'')+'<div class="caption">'+esc(p.caption)+'</div><div class="statusline'+jobClass+'">'+esc(renderStatus(p))+'</div></div>'+actions+'</article>';
}

async function loadQueue() {
  clearTimeout(timer);
  const box = document.getElementById('queue');
  const summary = document.getElementById('summary');
  try {
    const res = await fetch('?api=queue', {cache:'no-store'});
    if (res.status === 401) { location.reload(); return; }
    const body = await res.json();
    if (!res.ok) throw new Error(body.message || body.error || 'Unable to load queue');
    const items = body.items || [];
    const review = items.filter(x => x.status === 'review').length;
    const approved = items.filter(x => x.status === 'approved').length;
    summary.textContent = review + ' waiting · ' + approved + ' approved';
    box.innerHTML = items.length ? items.map(card).join('') : '<div class="empty"><h2>Nothing waiting</h2><p>Prepared packages will appear here for approval.</p></div>';
    if (items.some(x => x.status === 'approved' && ['queued','rendering'].includes(x.render_job?.status))) {
      timer = setTimeout(loadQueue, 7000);
    }
  } catch (e) {
    summary.textContent = 'Unable to load';
    box.innerHTML = '<div class="empty error">'+esc(e.message)+'</div>';
  }
}

async function decide(id, decision) {
  const note = document.getElementById('note-'+id)?.value || null;
  const label = decision === 'approve' ? 'Approve this package?' : 'Reject this package?';
  if (!confirm(label)) return;
  const res = await fetch('?api=decision', {
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({content_package_id:id, decision, note})
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { alert(body.message || body.error || 'Action failed'); return; }
  await loadQueue();
}

async function logout() {
  await fetch('?api=logout', {method:'POST'});
  location.reload();
}

loadQueue();
</script>
</body>
</html>`;

const loginHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chai O'Clock Review</title><style>body{font-family:system-ui;background:#f4f2ed;margin:0;padding:60px 22px;color:#171717}.card{max-width:520px;margin:auto;background:#fff;border:1px solid #ddd8cf;border-radius:20px;padding:28px}h1{font-family:Georgia,serif;font-style:italic}.muted{color:#6d6961;line-height:1.5}</style></head><body><div class="card"><h1>Chai O'Clock</h1><h2>Private review page</h2><p class="muted">This browser is not signed in to the approval dashboard. Open a current one-time setup link to authorize this device.</p></div></body></html>`;

Deno.serve(async (req: Request) => {
  const supabase = supabaseAdmin();
  const url = new URL(req.url);
  const setup = url.searchParams.get("setup");

  if (req.method === "GET" && setup) {
    const valid = await validSetupToken(setup, supabase);
    if (!valid) {
      return page(
        401,
        loginHtml.replace(
          "Open a current one-time setup link to authorize this device.",
          "This setup link is invalid, expired, or has already been used.",
        ),
      );
    }

    return page(
      200,
      `<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize Chai O'Clock Review</title>
  <style>
    body{font-family:system-ui;background:#f4f2ed;margin:0;padding:60px 22px;color:#171717}
    .card{max-width:520px;margin:auto;background:#fff;border:1px solid #ddd8cf;border-radius:20px;padding:28px}
    h1{font-family:Georgia,serif;font-style:italic}
    p{color:#6d6961;line-height:1.5}
    button{width:100%;border:0;border-radius:12px;padding:14px 16px;background:#171717;color:#fff;font:inherit;font-weight:700}
  </style>
</head>
<body>
  <div class="card">
    <h1>Chai O'Clock</h1>
    <h2>Authorize this browser</h2>
    <p>This one-time link is valid. Press the button below to sign this browser into the private review dashboard for 30 days.</p>
    <form method="post">
      <button type="submit">Authorize this browser</button>
    </form>
  </div>
</body>
</html>`
    );
  }

  if (req.method === "POST" && setup) {
    const rawSession = await establishSession(setup, supabase);
    if (!rawSession) {
      return page(
        401,
        loginHtml.replace(
          "Open a current one-time setup link to authorize this device.",
          "This setup link is invalid, expired, or has already been used.",
        ),
      );
    }

    return new Response(null, {
      status: 303,
      headers: {
        location: url.origin + url.pathname,
        "set-cookie":
          `${COOKIE}=${encodeURIComponent(rawSession)}; HttpOnly; Secure; SameSite=Lax; Path=${url.pathname}; Max-Age=${SESSION_SECONDS}`,
        "cache-control": "no-store",
      },
    });
  }

  const session = await getSession(req, supabase);

  if (!session) {
    if (url.searchParams.get("api")) return json(401, { error: "unauthorized" });
    return page(401, loginHtml);
  }

  const api = url.searchParams.get("api");

  if (req.method === "GET" && api === "queue") {
    try {
      return json(200, { items: await queueData(supabase) });
    } catch (error) {
      return json(500, {
        error: "queue_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (req.method === "POST" && api === "decision") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "invalid_json" });
    }

    if (!body?.content_package_id || !["approve", "reject"].includes(body?.decision)) {
      return json(400, { error: "invalid_decision_request" });
    }

    const { data, error } = await supabase.rpc("review_content_package", {
      p_content_package_id: body.content_package_id,
      p_decision: body.decision,
      p_note: body.note ?? null,
      p_actor: session.actor,
    });

    if (error) {
      return json(400, { error: "review_failed", message: error.message });
    }

    return json(200, { ok: true, result: data });
  }

  if (req.method === "POST" && api === "logout") {
    await supabase
      .from("dashboard_sessions")
      .delete()
      .eq("token_hash", session.tokenHash);

    return json(
      200,
      { ok: true },
      {
        "set-cookie":
          `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=${url.pathname}; Max-Age=0`,
      },
    );
  }

  if (req.method !== "GET") return json(405, { error: "method_not_allowed" });

  return page(200, dashboardHtml);
});

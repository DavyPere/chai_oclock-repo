const CANVA_API = "https://api.canva.com/rest/v1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function canvaFetch(path, token, options = {}) {
  const res = await fetch(`${CANVA_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Canva API ${options.method || "GET"} ${path} failed: ${res.status} ${JSON.stringify(body)}`
    );
  }
  return body;
}

async function pollJob(path, token, initialJob, timeoutMs = 120000) {
  let job = initialJob;
  const deadline = Date.now() + timeoutMs;

  while (job?.status === "in_progress") {
    if (!job.id) throw new Error("Canva returned an in-progress job without an id.");
    if (Date.now() >= deadline) throw new Error(`Timed out polling Canva job ${job.id}.`);
    await sleep(1500);
    const body = await canvaFetch(`${path}/${job.id}`, token);
    job = body.job;
  }

  if (job?.status === "failed") {
    throw new Error(`Canva job failed: ${JSON.stringify(job.error || {})}`);
  }
  if (job?.status !== "success") {
    throw new Error(`Unexpected Canva job state: ${JSON.stringify(job)}`);
  }
  return job;
}

async function getOAuthCredentials(supabase) {
  const envClientId = process.env.CANVA_CLIENT_ID?.trim();
  const envClientSecret = process.env.CANVA_CLIENT_SECRET?.trim();

  if (envClientId && envClientSecret) {
    return { clientId: envClientId, clientSecret: envClientSecret };
  }

  const { data, error } = await supabase.rpc("get_canva_oauth_credentials");
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.client_id || !row?.client_secret) {
    throw new Error("Canva OAuth client credentials are not stored in Supabase Vault.");
  }

  return {
    clientId: row.client_id,
    clientSecret: row.client_secret,
  };
}

export async function getCanvaAccessToken(supabase) {
  if (process.env.CANVA_ACCESS_TOKEN) {
    return process.env.CANVA_ACCESS_TOKEN.trim();
  }

  const { clientId, clientSecret } = await getOAuthCredentials(supabase);

  const { data: refreshToken, error: readError } = await supabase.rpc(
    "get_canva_refresh_token"
  );
  if (readError) throw readError;
  if (!refreshToken) {
    throw new Error("No Canva refresh token is stored in Supabase Vault.");
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetch(`${CANVA_API}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Canva token refresh failed: ${res.status} ${JSON.stringify(body)}`);
  }

  if (!body.access_token || !body.refresh_token) {
    throw new Error("Canva token refresh response was incomplete.");
  }

  const { error: writeError } = await supabase.rpc("set_canva_refresh_token", {
    p_refresh_token: body.refresh_token,
  });
  if (writeError) throw writeError;

  return body.access_token;
}

export async function removeBackground(token, assetId, name) {
  const created = await canvaFetch("/image-transformations", token, {
    method: "POST",
    body: JSON.stringify({
      asset_id: assetId,
      name,
      transformations: [{ type: "background_removal" }],
    }),
  });
  const job = await pollJob("/image-transformations", token, created.job);
  const outputAssetId = job?.result?.asset?.id;
  if (!outputAssetId) throw new Error("Background-removal job returned no output asset.");
  return outputAssetId;
}

export async function createAutofilledDesign(token, designId, title, data) {
  const created = await canvaFetch("/autofills", token, {
    method: "POST",
    body: JSON.stringify({
      type: "create_from_design",
      design_id: designId,
      title,
      data,
    }),
  });
  const job = await pollJob("/autofills", token, created.job);
  const design = job?.result?.design;
  if (!design?.id) throw new Error("Autofill job returned no design.");
  return design;
}

export async function exportDesignPng(token, designId) {
  const created = await canvaFetch("/exports", token, {
    method: "POST",
    body: JSON.stringify({
      design_id: designId,
      format: {
        type: "png",
        pages: [1],
        lossless: true,
      },
    }),
  });
  const job = await pollJob("/exports", token, created.job);
  const url = job?.urls?.[0];
  if (!url) throw new Error("Canva export returned no download URL.");
  return url;
}

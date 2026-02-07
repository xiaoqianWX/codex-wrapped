interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

interface ProviderInfo {
  id: string;
  name: string;
}

interface ModelsDevData {
  models: Record<string, ModelInfo>;
  providers: Record<string, ProviderInfo>;
}

const MODELS_API_URL = "https://models.dev/api.json";
const FETCH_ABORT_TIMEOUT_MS = 3000;
const FETCH_HARD_TIMEOUT_MS = 4000;
const EMPTY_DATA: ModelsDevData = { models: {}, providers: {} };

let cachedData: ModelsDevData = EMPTY_DATA;
let fetchAttempted = false;
let fetchInFlight: Promise<ModelsDevData> | null = null;

export async function fetchModelsData(): Promise<ModelsDevData> {
  if (fetchAttempted) {
    return cachedData;
  }
  if (fetchInFlight) {
    return fetchInFlight;
  }

  fetchInFlight = (async () => {
    const controller = new AbortController();
    const abortTimeout = setTimeout(() => controller.abort(), FETCH_ABORT_TIMEOUT_MS);
    try {
      const response = await withTimeout(
        fetch(MODELS_API_URL, { signal: controller.signal }),
        FETCH_HARD_TIMEOUT_MS,
        "models.dev request timed out"
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await withTimeout(
        response.json(),
        FETCH_HARD_TIMEOUT_MS,
        "models.dev response parsing timed out"
      );

      const models: Record<string, ModelInfo> = {};
      const providers: Record<string, ProviderInfo> = {};

      if (data && typeof data === "object") {
        for (const [providerId, providerData] of Object.entries(data)) {
          if (!providerData || typeof providerData !== "object") continue;

          const pd = providerData as { name?: string; models?: Record<string, { name?: string }> };

          if (pd.name) {
            providers[providerId] = {
              id: providerId,
              name: pd.name,
            };
          }

          if (pd.models && typeof pd.models === "object") {
            for (const [modelId, modelData] of Object.entries(pd.models)) {
              if (modelData && typeof modelData === "object" && modelData.name) {
                models[modelId] = {
                  id: modelId,
                  name: modelData.name,
                  provider: providerId,
                };
              }
            }
          }
        }
      }

      cachedData = { models, providers };
      return cachedData;
    } catch {
      cachedData = EMPTY_DATA;
      return cachedData;
    } finally {
      clearTimeout(abortTimeout);
      fetchAttempted = true;
      fetchInFlight = null;
    }
  })();

  return fetchInFlight;
}

export function getModelDisplayName(modelId: string): string {
  if (cachedData.models[modelId]?.name) {
    return normalizeModelName(cachedData.models[modelId].name);
  }

  return normalizeModelName(formatModelIdAsName(modelId));
}

export function getModelProvider(modelId: string): string {
  if (cachedData.models[modelId]?.provider) {
    return cachedData.models[modelId].provider;
  }

  return "unknown";
}

export function getProviderDisplayName(providerId: string): string {
  if (cachedData?.providers[providerId]?.name) {
    return cachedData.providers[providerId].name;
  }

  return providerId.charAt(0).toUpperCase() + providerId.slice(1);
}

export function getProviderLogoUrl(providerId: string): string {
  return `https://models.dev/logos/${providerId}.svg`;
}

function formatModelIdAsName(modelId: string): string {
  return modelId
    .split(/[-_]/)
    .map((part) => {
      if (/^\d/.test(part)) return part;
      if (part.toLowerCase() === "gpt") return "GPT";

      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function normalizeModelName(name: string): string {
  return name.replace(/\bgpt\b/gi, "GPT").replace(/\bgpt(?=[-0-9])/gi, "GPT");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

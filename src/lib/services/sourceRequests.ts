import { getSourceAuthHeaders } from "../storage/sourceTokenStorage";

/** Identify source downloads as app requests; Codeberg rejects some browser UAs. */
export const getSourceRequestHeaders = (
  author: string | undefined,
  url: string,
): Record<string, string> => ({
  "User-Agent": "VegaDesktop",
  ...getSourceAuthHeaders(author, url),
});

export const isRateLimitError = (error: unknown): boolean => {
  const response = (error as any)?.response;
  const status = response?.status ?? (error as any)?.status;
  if (status === 429) return true;

  const message = [
    (error as any)?.message,
    typeof response?.data === "string"
      ? response.data
      : response?.data?.message,
  ].filter(Boolean).join(" ").toLowerCase();
  return message.includes("rate limit") ||
    (status === 403 && String(response?.headers?.["x-ratelimit-remaining"]) === "0");
};

export const throwIfRateLimited = (error: unknown): void => {
  if (isRateLimitError(error)) {
    throw new Error(
      "Provider source rate limit exceeded. Please wait a few minutes before trying again.",
    );
  }
};

export const throwIfSourceForbidden = (error: unknown): void => {
  if (((error as any)?.response?.status ?? (error as any)?.status) === 403) {
    throw new Error(
      "The provider source denied access (HTTP 403). Check the source URL and any required access token.",
    );
  }
};

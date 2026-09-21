import * as vscode from "vscode";

/**
 * Maximum length of a STARLIMS SCM_API URL. ASP.NET rejects requests whose query string exceeds
 * its `maxQueryStringLength` (2048 by default) with an HTTP 400 HTML page instead of JSON, so we
 * stay clearly below that limit.
 */
export const MAX_STARLIMS_QUERY_URL_LENGTH = 1800;

/**
 * Truncates a query string value so that its encoded representation fits into the given character
 * budget. Characters are removed as whole units so no percent escape is broken apart.
 *
 * @param value the raw value to clamp
 * @param budget the maximum allowed length of the encoded value
 * @param encodedLength a function returning the encoded length of a candidate value
 * @returns the longest prefix of `value` whose encoded length fits into `budget`
 */
export function clampValueToEncodedBudget(
  value: string,
  budget: number,
  encodedLength: (candidate: string) => number
): string {
  if (encodedLength(value) <= budget) {
    return value;
  }

  if (budget <= 0) {
    return "";
  }

  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encodedLength(value.slice(0, mid)) <= budget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return value.slice(0, low);
}

/**
 * Removes the trailing `/` and any `.lims` suffix from the specified STARLIMS system URL.
 * @param url the URL to clean up.
 */
export function cleanUrl(url: string): string {
  let newUrl = url.endsWith("/") ? url.slice(0, -1) : url;
  if (newUrl.toLowerCase().endsWith(".lims")) {
    newUrl = newUrl.slice(0, newUrl.lastIndexOf("/"));
  }
  return newUrl;
}

/**
 * Wraps a long running task specified by ```fn```` with a progress bar info message displayed in the VS Code
 * status bar.
 *
 * @param fn an async function which executes a long running task
 * @param progressMessage the message to display in the VS Code progress indicator
 */
export async function executeWithProgress<T>(fn: () => Promise<T>, progressMessage: string): Promise<T> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      cancellable: false,
      title: "STARLIMS"
    },
    async (progress) => {
      progress.report({ increment: 0, message: progressMessage });
      const result = await fn();
      progress.report({ increment: 100, message: "Done." });
      return result;
    }
  );
}

/**
 * Checks if the provided string is a valid JSON string.
 *
 * @param str A string or character sequence to be tested for JSON validity.
 * @returns `true` if the string is valid JSON, otherwise `false`.
 */
export function isJson(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

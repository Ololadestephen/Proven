import { useEffect, useRef, useState } from "react";
import type { MarketBid, MarketJob } from "./market-steps.ts";
import {
  buildReceipt,
  deliveryFilename,
  displayWork,
  escrowJobId,
  matchesDelivery,
  type ReceiptNetwork,
} from "./receipt.ts";

/** Blob strings use UTF-8 with transparent line endings: no reformatting, BOM, or newline is added. */
function saveText(text: string, filename: string, type: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type, endings: "transparent" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    // Leave time for the browser to consume the URL before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

interface Verification {
  text: string;
  hash: string | null;
  matches: boolean;
  error?: string;
}
export function CollectedWork({
  bid,
  job,
  text,
  network,
}: {
  bid: MarketBid;
  job: MarketJob;
  text: string;
  network: ReceiptNetwork;
}) {
  const [verification, setVerification] = useState<Verification | null>(null);
  const [pretty, setPretty] = useState(false);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const copied = copiedText === text;
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<{ text: string; message: string } | null>(
    null,
  );
  const currentError = error?.text === text ? error.message : null;
  function reportError(message: string | null) {
    setError(message === null ? null : { text, message });
  }
  const work = displayWork(text);
  const currentText = useRef(text);
  currentText.current = text;
  useEffect(() => {
    let active = true;
    void matchesDelivery(text, job.deliverable_hash)
      .then((matches) => {
        if (active)
          setVerification({ text, hash: job.deliverable_hash, matches });
      })
      .catch(() => {
        if (active)
          setVerification({
            text,
            hash: job.deliverable_hash,
            matches: false,
            error:
              "The work’s fingerprint could not be checked. Downloads are unavailable.",
          });
      });
    return () => {
      active = false;
    };
  }, [text, job.deliverable_hash]);
  useEffect(() => {
    if (copiedText === null) return;
    const timer = setTimeout(() => setCopiedText(null), 2500);
    return () => clearTimeout(timer);
  }, [copiedText]);
  const checked =
    verification?.text === text && verification.hash === job.deliverable_hash
      ? verification
      : null;
  const downloadable = checked?.matches && escrowJobId(bid, job) !== null;
  function download(receipt: boolean) {
    if (!downloadable) return;
    try {
      if (receipt)
        saveText(
          buildReceipt(bid, job, text, network, new Date().toISOString()),
          `bid-${bid.id}-receipt.md`,
          "text/markdown;charset=utf-8",
        );
      else
        saveText(
          text,
          deliveryFilename(bid, job, text),
          work.isJson
            ? "application/json;charset=utf-8"
            : "text/plain;charset=utf-8",
        );
      reportError(null);
    } catch {
      reportError("The file could not be downloaded. Try again.");
    }
  }
  async function copy() {
    setCopying(true);
    try {
      await navigator.clipboard.writeText(text);
      if (currentText.current === text) {
        setCopiedText(text);
        reportError(null);
      }
    } catch {
      if (currentText.current === text)
        reportError(
          "The work could not be copied. You can select the exact text below.",
        );
    } finally {
      setCopying(false);
    }
  }
  return (
    <div className="market-collected">
      <strong>The delivered work, as untrusted text</strong>
      {!checked ? (
        <p className="collected-fingerprint" role="status">
          Checking the work’s fingerprint…
        </p>
      ) : checked.error ? (
        <p className="market-error" role="alert">
          {checked.error}
        </p>
      ) : checked.matches ? (
        <p className="collected-fingerprint collected-matches">
          Matches the fingerprint on the chain:{" "}
          {job.deliverable_hash!.slice(0, 12)}…
        </p>
      ) : (
        <p className="market-error" role="alert">
          This does not match the work recorded on the chain
        </p>
      )}
      {checked?.matches && escrowJobId(bid, job) === null ? (
        <p className="market-error" role="alert">
          The escrow job ID is not recorded. Downloads are unavailable.
        </p>
      ) : null}
      <div className="collected-controls">
        {downloadable ? (
          <>
            <button
              type="button"
              className="button button-primary"
              onClick={() => download(false)}
            >
              Download the work
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => download(true)}
            >
              Download receipt (.md)
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="button button-secondary"
          disabled={copying || copied}
          onClick={() => void copy()}
        >
          {copied ? "Copied" : copying ? "Copying…" : "Copy"}
        </button>
        <label className="collected-toggle">
          <input
            type="checkbox"
            checked={pretty && work.isJson}
            disabled={!work.isJson}
            onChange={(event) => setPretty(event.target.checked)}
          />
          Pretty view
        </label>
      </div>
      {currentError ? (
        <p className="market-error" role="alert">
          {currentError}
        </p>
      ) : null}
      <span className="collected-copy-status" role="status">
        {copied ? "Copied" : ""}
      </span>
      <pre className="market-pre">
        {pretty && work.isJson ? work.pretty : text}
      </pre>
    </div>
  );
}

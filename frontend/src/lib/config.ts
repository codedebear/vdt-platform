/**
 * Loads the server's runtime config (attachment limits + accepted file types)
 * once and shares it across components. The authoritative values come from
 * GET /api/config; the DEFAULT below is only a graceful fallback used while the
 * request is in flight or if it fails, so the UI never blocks on it.
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import type { AttachmentConfig } from './types';

/** Fallback used until the server config arrives (mirrors the shipped env defaults). */
export const DEFAULT_ATTACHMENT_CONFIG: AttachmentConfig = {
  maxFileMb: 10,
  maxPerRun: 5,
  maxTotalMb: 25,
  acceptedExtensions: ['.pdf', '.xlsx', '.xls', '.docx', '.txt', '.csv', '.md', '.markdown'],
};

// Module-level cache so the config is fetched at most once per page load.
let cache: Promise<AttachmentConfig> | null = null;

function loadAttachmentConfig(): Promise<AttachmentConfig> {
  if (!cache) {
    cache = api
      .getConfig()
      .then((c) => c.attachments)
      .catch(() => {
        cache = null; // allow a later retry
        return DEFAULT_ATTACHMENT_CONFIG;
      });
  }
  return cache;
}

/**
 * Returns the effective attachment config, starting from the default and
 * swapping in the server's values once loaded.
 */
export function useAttachmentConfig(): AttachmentConfig {
  const [config, setConfig] = useState<AttachmentConfig>(DEFAULT_ATTACHMENT_CONFIG);
  useEffect(() => {
    let active = true;
    loadAttachmentConfig().then((c) => active && setConfig(c));
    return () => {
      active = false;
    };
  }, []);
  return config;
}

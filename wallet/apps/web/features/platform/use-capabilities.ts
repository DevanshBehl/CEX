'use client';

import { useEffect, useState } from 'react';
import type { CapabilitiesResponse } from '@wallet/types';
import { api } from '@/lib/api/endpoints';

/**
 * What this deployment can actually do (prompt_phase4.md rules 236-237).
 *
 * Fetched once. Capabilities change on deploy, not while someone is looking at
 * a page, so polling would be noise.
 *
 * Returns `undefined` while loading AND on failure, deliberately. Every caller
 * renders the cautious copy in that case: if the platform cannot say what its
 * signing is, the honest thing to show is the weaker claim, not the stronger
 * one.
 */
export function useCapabilities(): CapabilitiesResponse | undefined {
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse>();

  useEffect(() => {
    let cancelled = false;
    void api
      .getCapabilities()
      .then((result) => {
        if (!cancelled) setCapabilities(result);
      })
      .catch(() => {
        // Left undefined. See the note above.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return capabilities;
}

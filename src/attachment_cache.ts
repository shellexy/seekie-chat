import { useEffect, useState } from 'react';
import { api } from './api';
import type { Attachment } from './types';

// Attachment payloads stay in the main process and never travel with a state broadcast: the renderer
// asks for one by id the first time it has to show it and remembers it for the rest of the session.
// Attachments the user just added already carry their own payload, so drafts never need a round trip.
const payloads = new Map<string, string>();
const inflight = new Map<string, Promise<void>>();

export function attachmentPayload(attachment?: Attachment | null) {
  if (!attachment) return '';
  return attachment.data || payloads.get(attachment.id) || '';
}

function requestPayload(id: string) {
  const running = inflight.get(id);
  if (running) return running;
  const pending = api.attachment(id)
    .then(value => { if (value) payloads.set(id, value); })
    .catch(() => { /* a missing payload simply keeps the attachment unrendered */ })
    .finally(() => { inflight.delete(id); });
  inflight.set(id, pending);
  return pending;
}

export function useAttachmentPayload(attachment?: Attachment | null) {
  const [payload, setPayload] = useState(() => attachmentPayload(attachment));
  const id = attachment?.id, inline = attachment?.data;
  useEffect(() => {
    const known = attachmentPayload(attachment);
    if (known) { setPayload(known); return; }
    if (!id) return;
    let active = true;
    void requestPayload(id).then(() => { if (active) setPayload(attachmentPayload(attachment)); });
    return () => { active = false; };
  }, [id, inline]);
  return payload;
}

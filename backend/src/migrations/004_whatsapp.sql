-- WhatsApp delivery of notifications, through the official WhatsApp Business
-- Platform (Cloud API). Until the academy connects its WhatsApp Business
-- number, messages are kept here as previews and nothing is sent.

ALTER TABLE users ADD COLUMN whatsapp_phone text;
-- WhatsApp's rules require that people agree to receive messages.
ALTER TABLE users ADD COLUMN whatsapp_opt_in boolean NOT NULL DEFAULT false;

CREATE TABLE whatsapp_settings (
  id                 boolean PRIMARY KEY DEFAULT true CHECK (id),
  phone_number_id    text,
  -- Encrypted with the server's MESSAGING_KEY; never returned by the API.
  access_token_enc   text,
  template_name      text NOT NULL DEFAULT 'academy_update',
  template_language  text NOT NULL DEFAULT 'en',
  -- A WhatsApp group for coaches (needs Meta's Groups API and an Official Business Account).
  coach_group_id     text,
  -- Local hour (0-23) for the end-of-day coach summary.
  digest_hour        smallint NOT NULL DEFAULT 20 CHECK (digest_hour BETWEEN 0 AND 23),
  digest_enabled     boolean NOT NULL DEFAULT true,
  last_digest_on     date,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO whatsapp_settings DEFAULT VALUES;

CREATE TABLE whatsapp_messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 text NOT NULL,
  to_user_id           uuid REFERENCES users(id),
  to_phone             text,
  to_group             text,
  body                 text NOT NULL,
  -- queued -> sent | failed; 'preview' when WhatsApp isn't connected yet;
  -- 'skipped' when the person has no number or hasn't agreed to WhatsApp.
  status               text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'preview', 'skipped')),
  status_reason        text,
  provider_message_id  text,
  attempts             integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  CHECK (to_phone IS NOT NULL OR to_group IS NOT NULL OR status = 'skipped')
);
CREATE INDEX whatsapp_messages_queued ON whatsapp_messages(created_at) WHERE status = 'queued';
CREATE INDEX whatsapp_messages_created ON whatsapp_messages(created_at DESC);

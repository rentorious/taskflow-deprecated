-- Web Push: one row per browser that asked to be told, bound to the person signed in
-- there. The keys are the browser's own, so the push service cannot read what we send;
-- the endpoint is that service's address for that one browser.

create table push_subscription (
  id bigint generated always as identity primary key,
  user_id bigint not null references app_user (id) on delete cascade,
  endpoint text not null unique check (length(endpoint) <= 2000),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{86,88}$'),   -- a 65-byte P-256 point, base64url
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{22}$'),          -- a 16-byte secret, base64url
  user_agent text not null default '' check (length(user_agent) <= 300),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  failures int not null default 0                                   -- consecutive; the row is dropped after many
);
create index push_subscription_by_user on push_subscription (user_id);

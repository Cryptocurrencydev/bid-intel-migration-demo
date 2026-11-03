-- Re-hosted Bubble files: lets a re-run skip files that are already in Storage with the same hash.
create table migration.files (
  bubble_url text primary key,
  bucket text not null,
  path text not null,
  sha256 text not null,
  bytes integer not null,
  uploaded_at timestamptz not null default now()
);
create table migration.issues (
  run_id bigint not null references migration.runs (id) on delete cascade,
  severity text not null,
  kind text not null,
  bubble_type text not null,
  bubble_id text not null,
  detail text not null
);
alter table migration.files enable row level security;
alter table migration.issues enable row level security;
alter table migration.runs enable row level security;
alter table migration.checkpoints enable row level security;
grant all on migration.files, migration.issues to service_role;

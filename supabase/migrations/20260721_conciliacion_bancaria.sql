-- Conciliación bancaria MAE · BCI
-- Ejecutar una vez en el SQL Editor del proyecto Supabase de VALEPAC.

create extension if not exists pgcrypto;

create table if not exists public.conciliacion_lotes (
  id uuid primary key default gen_random_uuid(),
  estacion text not null default '40098',
  creado_por text,
  periodo_desde date not null,
  periodo_hasta date not null,
  ventana_minutos integer not null default 180 check (ventana_minutos between 1 and 1440),
  mae_archivo_nombre text not null,
  mae_archivo_sha256 text not null,
  mae_storage_path text not null,
  bci_archivo_nombre text not null,
  bci_archivo_sha256 text not null,
  bci_storage_path text not null,
  mae_cantidad integer not null default 0,
  mae_monto bigint not null default 0,
  bci_caja_cantidad integer not null default 0,
  bci_caja_monto bigint not null default 0,
  conciliados_cantidad integer not null default 0,
  conciliados_monto bigint not null default 0,
  pendiente_mae_cantidad integer not null default 0,
  pendiente_mae_monto bigint not null default 0,
  pendiente_bci_cantidad integer not null default 0,
  pendiente_bci_monto bigint not null default 0,
  fuera_alcance_cantidad integer not null default 0,
  fuera_alcance_monto bigint not null default 0,
  estado text not null check (estado in ('conciliado','con_excepciones')),
  resumen jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (mae_archivo_sha256, bci_archivo_sha256)
);

create table if not exists public.conciliacion_mae (
  lote_id uuid not null references public.conciliacion_lotes(id) on delete cascade,
  source_key text not null,
  source_row integer not null,
  occurred_at timestamp without time zone not null,
  maquina text,
  cliente text,
  usuario text,
  tipo text not null,
  moneda text not null,
  monto bigint not null check (monto > 0),
  primary key (lote_id, source_key)
);

create table if not exists public.conciliacion_bci (
  lote_id uuid not null references public.conciliacion_lotes(id) on delete cascade,
  source_key text not null,
  source_row integer not null,
  occurred_at timestamp without time zone not null,
  fecha_contable date,
  codigo_transaccion text,
  tipo text not null,
  glosa text,
  monto bigint not null check (monto > 0),
  en_alcance boolean not null default false,
  motivo_exclusion text,
  primary key (lote_id, source_key)
);

create table if not exists public.conciliacion_matches (
  lote_id uuid not null references public.conciliacion_lotes(id) on delete cascade,
  mae_source_key text not null,
  bci_source_key text not null,
  estado text not null check (estado in ('conciliado','demora')),
  monto bigint not null check (monto > 0),
  diferencia_segundos integer not null,
  cruza_dia boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (lote_id, mae_source_key, bci_source_key),
  foreign key (lote_id, mae_source_key) references public.conciliacion_mae(lote_id, source_key) on delete cascade,
  foreign key (lote_id, bci_source_key) references public.conciliacion_bci(lote_id, source_key) on delete cascade
);

create index if not exists conciliacion_lotes_periodo_idx on public.conciliacion_lotes(periodo_desde desc, periodo_hasta desc);
create index if not exists conciliacion_mae_fecha_idx on public.conciliacion_mae(lote_id, occurred_at);
create index if not exists conciliacion_bci_fecha_idx on public.conciliacion_bci(lote_id, occurred_at);
create index if not exists conciliacion_bci_codigo_idx on public.conciliacion_bci(codigo_transaccion);

alter table public.conciliacion_lotes enable row level security;
alter table public.conciliacion_mae enable row level security;
alter table public.conciliacion_bci enable row level security;
alter table public.conciliacion_matches enable row level security;

revoke all on table public.conciliacion_lotes from anon, authenticated;
revoke all on table public.conciliacion_mae from anon, authenticated;
revoke all on table public.conciliacion_bci from anon, authenticated;
revoke all on table public.conciliacion_matches from anon, authenticated;
grant select, insert, update, delete on table public.conciliacion_lotes to service_role;
grant select, insert, update, delete on table public.conciliacion_mae to service_role;
grant select, insert, update, delete on table public.conciliacion_bci to service_role;
grant select, insert, update, delete on table public.conciliacion_matches to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'conciliaciones-bancarias',
  'conciliaciones-bancarias',
  false,
  8388608,
  array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-excel']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.guardar_conciliacion_bancaria(p_payload jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_lote jsonb := p_payload -> 'lote';
  v_id uuid := (v_lote ->> 'id')::uuid;
begin
  if jsonb_typeof(p_payload -> 'mae') <> 'array'
     or jsonb_typeof(p_payload -> 'bci') <> 'array'
     or jsonb_typeof(p_payload -> 'matches') <> 'array' then
    raise exception 'Payload de conciliación incompleto';
  end if;

  insert into public.conciliacion_lotes (
    id, estacion, creado_por, periodo_desde, periodo_hasta, ventana_minutos,
    mae_archivo_nombre, mae_archivo_sha256, mae_storage_path,
    bci_archivo_nombre, bci_archivo_sha256, bci_storage_path,
    mae_cantidad, mae_monto, bci_caja_cantidad, bci_caja_monto,
    conciliados_cantidad, conciliados_monto,
    pendiente_mae_cantidad, pendiente_mae_monto,
    pendiente_bci_cantidad, pendiente_bci_monto,
    fuera_alcance_cantidad, fuera_alcance_monto, estado, resumen
  ) values (
    v_id, v_lote ->> 'estacion', nullif(v_lote ->> 'creado_por',''),
    (v_lote ->> 'periodo_desde')::date, (v_lote ->> 'periodo_hasta')::date,
    (v_lote ->> 'ventana_minutos')::integer,
    v_lote ->> 'mae_archivo_nombre', v_lote ->> 'mae_archivo_sha256', v_lote ->> 'mae_storage_path',
    v_lote ->> 'bci_archivo_nombre', v_lote ->> 'bci_archivo_sha256', v_lote ->> 'bci_storage_path',
    (v_lote ->> 'mae_cantidad')::integer, (v_lote ->> 'mae_monto')::bigint,
    (v_lote ->> 'bci_caja_cantidad')::integer, (v_lote ->> 'bci_caja_monto')::bigint,
    (v_lote ->> 'conciliados_cantidad')::integer, (v_lote ->> 'conciliados_monto')::bigint,
    (v_lote ->> 'pendiente_mae_cantidad')::integer, (v_lote ->> 'pendiente_mae_monto')::bigint,
    (v_lote ->> 'pendiente_bci_cantidad')::integer, (v_lote ->> 'pendiente_bci_monto')::bigint,
    (v_lote ->> 'fuera_alcance_cantidad')::integer, (v_lote ->> 'fuera_alcance_monto')::bigint,
    v_lote ->> 'estado', coalesce(v_lote -> 'resumen','{}'::jsonb)
  );

  insert into public.conciliacion_mae (
    lote_id, source_key, source_row, occurred_at, maquina, cliente, usuario, tipo, moneda, monto
  )
  select
    v_id, item ->> 'source_key', (item ->> 'source_row')::integer,
    (item ->> 'occurred_at')::timestamp, nullif(item ->> 'maquina',''),
    nullif(item ->> 'cliente',''), nullif(item ->> 'usuario',''),
    item ->> 'tipo', item ->> 'moneda', (item ->> 'monto')::bigint
  from jsonb_array_elements(p_payload -> 'mae') item;

  insert into public.conciliacion_bci (
    lote_id, source_key, source_row, occurred_at, fecha_contable, codigo_transaccion,
    tipo, glosa, monto, en_alcance, motivo_exclusion
  )
  select
    v_id, item ->> 'source_key', (item ->> 'source_row')::integer,
    (item ->> 'occurred_at')::timestamp,
    nullif(item ->> 'fecha_contable','')::date,
    nullif(item ->> 'codigo_transaccion',''), item ->> 'tipo', nullif(item ->> 'glosa',''),
    (item ->> 'monto')::bigint, coalesce((item ->> 'en_alcance')::boolean,false),
    nullif(item ->> 'motivo_exclusion','')
  from jsonb_array_elements(p_payload -> 'bci') item;

  insert into public.conciliacion_matches (
    lote_id, mae_source_key, bci_source_key, estado, monto, diferencia_segundos, cruza_dia
  )
  select
    v_id, item ->> 'mae_source_key', item ->> 'bci_source_key', item ->> 'estado',
    (item ->> 'monto')::bigint, (item ->> 'diferencia_segundos')::integer,
    coalesce((item ->> 'cruza_dia')::boolean,false)
  from jsonb_array_elements(p_payload -> 'matches') item;

  return v_id;
end;
$$;

revoke execute on function public.guardar_conciliacion_bancaria(jsonb) from public, anon, authenticated;
grant execute on function public.guardar_conciliacion_bancaria(jsonb) to service_role;

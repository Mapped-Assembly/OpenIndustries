-- Persist retry identity beside each immutable revision, in the same transaction.
alter table public.scene_revisions add column write_id uuid, add column expected_revision integer;
-- Older API revisions without request identity remain readable but cannot gain a receipt retroactively.
with candidates as (
  select r.scene_id,r.revision,r.owner_id,
    case when r.revision=s.revision then s.last_write_id
      when r.document#>>'{authoring,request_id}' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then (r.document#>>'{authoring,request_id}')::uuid end as write_id
  from public.scene_revisions r join public.scenes s on s.id=r.scene_id
), unique_ids as (select owner_id,write_id from candidates where write_id is not null group by owner_id,write_id having count(*)=1)
update public.scene_revisions r set write_id=c.write_id,expected_revision=r.revision-1
from candidates c join unique_ids u using(owner_id,write_id) where r.scene_id=c.scene_id and r.revision=c.revision;
create unique index scene_revision_write_identity on public.scene_revisions(owner_id,write_id) where write_id is not null;

-- Field names and stable IDs only: no values, geometry, source data or other owners' data.
create function public.scene_conflict_details(p_id uuid,p_expected integer,p_head public.scenes)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare previous public.scene_revisions; changes jsonb := '[]'; fields jsonb := '[]'; item record; changed jsonb; k text;
begin
  select * into previous from public.scene_revisions where scene_id=p_id and revision=p_expected and owner_id=auth.uid();
  if previous.scene_id is not null then
    for item in
      with a as (select value->>'id' id,value from jsonb_array_elements(previous.document->'instances')),
           b as (select value->>'id' id,value from jsonb_array_elements(p_head.document->'instances'))
      select coalesce(a.id,b.id) id,a.value av,b.value bv from a full join b using(id) order by coalesce(a.id,b.id)
    loop
      changed:='[]';
      if item.av is null or item.bv is null then changed:='["presence"]';
      else
        foreach k in array array['name','asset','position','rotation','visible'] loop
          if (k='asset' and (item.av->'assetId' is distinct from item.bv->'assetId' or item.av->'cloudVersionId' is distinct from item.bv->'cloudVersionId'))
            or (k<>'asset' and item.av->k is distinct from item.bv->k) then changed:=changed||to_jsonb(k); end if;
        end loop;
      end if;
      if jsonb_array_length(changed)>0 then changes:=changes||jsonb_build_array(jsonb_build_object('instance_id',item.id,
        'change',case when item.av is null then 'added' when item.bv is null then 'removed' else 'updated' end,'fields',changed)); end if;
    end loop;
    if previous.name is distinct from p_head.name then fields:=fields||'"name"'::jsonb; end if;
    foreach k in array array['room','assets','animation'] loop
      if previous.document->k is distinct from p_head.document->k then fields:=fields||to_jsonb(k); end if;
    end loop;
    if (select jsonb_agg(value->'id') from jsonb_array_elements(previous.document->'instances')) is distinct from
       (select jsonb_agg(value->'id') from jsonb_array_elements(p_head.document->'instances')) then fields:=fields||'"instance_order"'::jsonb; end if;
  end if;
  return jsonb_build_object('scene_id',p_id,'expected_revision',p_expected,'actual_revision',p_head.revision,'current_revision',p_head.revision,
    'applied',false,'base_available',previous.scene_id is not null,'changed_instances',changes,'scene_fields',fields,'retry','refresh_and_reapply');
end;
$$;
revoke all on function public.scene_conflict_details(uuid,integer,public.scenes) from public,anon,authenticated;

create function public.get_scene_write_receipt(p_id uuid,p_write_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare receipt public.scene_revisions;
begin
  if auth.uid() is null then raise exception 'Sign in to read scene receipts'; end if;
  select * into receipt from public.scene_revisions where owner_id=auth.uid() and write_id=p_write_id;
  if not found then return null; end if;
  if receipt.scene_id<>p_id then raise exception using errcode='OI001',message='Request ID already used for a different scene write'; end if;
  return jsonb_build_object('id',receipt.scene_id,'name',receipt.name,'revision',receipt.revision,'last_write_id',receipt.write_id,'document',receipt.document);
end;
$$;
revoke all on function public.get_scene_write_receipt(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_scene_write_receipt(uuid,uuid) to authenticated;

create or replace function public.save_workspace_scene(p_id uuid, p_name text, p_document jsonb, p_expected_revision integer, p_write_id uuid)
returns public.scenes language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); result public.scenes; item jsonb; version_id uuid; receipt public.scene_revisions;
begin
  if uid is null then raise exception 'Sign in to save a cloud scene'; end if;
  if p_id is null or p_write_id is null or p_expected_revision is null or p_expected_revision < 0 or p_expected_revision > 2147483646 then raise exception 'Invalid scene write identity'; end if;
  if jsonb_typeof(p_document) is distinct from 'object' or p_document->>'format' is distinct from 'astra.scene'
    or p_document->>'version' is distinct from '1' or p_document->>'units' is distinct from 'm'
    or p_document->>'upAxis' is distinct from 'Y' or jsonb_typeof(p_document->'instances') is distinct from 'array'
    or p_document ? 'bundledAssets' or p_document ? 'bundledVersions' then raise exception 'Expected a Mergence scene manifest without binary geometry'; end if;
  if jsonb_array_length(p_document->'instances') > 1000 then raise exception 'Scene exceeds 1000 instances'; end if;
  -- Serialize new-scene inserts too; restores acquire the same lock before their row lock.
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
  select * into receipt from public.scene_revisions where owner_id=uid and write_id=p_write_id;
  if found then
    if receipt.scene_id<>p_id or receipt.expected_revision<>p_expected_revision or receipt.name is distinct from p_name or receipt.document is distinct from p_document then
      raise exception using errcode='OI001',message='Request ID already used for a different scene write';
    end if;
    select * into result from public.scenes where id=p_id and owner_id=uid;
    result.name:=receipt.name; result.document:=receipt.document; result.revision:=receipt.revision; result.last_write_id:=receipt.write_id;
    result.updated_at:=receipt.created_at; result.revision_url:='/?sceneId='||p_id::text||'&revision='||receipt.revision::text;
    return result;
  end if;
  select * into result from public.scenes where id=p_id for update;
  if found then
    if result.owner_id <> uid then raise exception 'Scene not found'; end if;
    if result.revision<>p_expected_revision then raise exception using errcode='40001',message='Scene changed on another device. Refresh and reapply your edit',detail=public.scene_conflict_details(p_id,p_expected_revision,result)::text; end if;
    update public.scenes set name=p_name, document=p_document, revision=revision+1,last_write_id=p_write_id where id=p_id returning * into result;
  else
    if p_expected_revision<>0 then raise exception 'Scene was deleted. Save a new copy'; end if;
    insert into public.scenes(id,owner_id,name,document,last_write_id) values(p_id,uid,p_name,p_document,p_write_id) returning * into result;
  end if;
  delete from public.scene_asset_files where scene_id=p_id;
  for item in select value from jsonb_array_elements(p_document->'instances') where value ? 'cloudVersionId' order by value->>'cloudVersionId' loop
    version_id := (item->>'cloudVersionId')::uuid;
    if not exists(select 1 from public.asset_file_versions v join public.assets a on a.id=v.asset_id
      where v.id=version_id and v.owner_id=uid and v.state='ready' and a.asset_key=item->>'assetId') then
      raise exception 'A cloud asset is missing, belongs to another user, or is not ready';
    end if;
    insert into public.scene_asset_files(scene_id,version_id,owner_id) values(p_id,version_id,uid) on conflict do nothing;
  end loop;
  begin
    update public.scene_revisions set write_id=p_write_id,expected_revision=p_expected_revision where scene_id=p_id and revision=result.revision;
  exception when unique_violation then
    raise exception using errcode='OI001',message='Request ID already used for a different scene write';
  end;
  return result;
end;
$$;

create or replace function public.delete_workspace_scene(p_id uuid,p_expected_revision integer) returns void
language plpgsql security definer set search_path='' as $$
declare result public.scenes;
begin
  if auth.uid() is null then raise exception 'Sign in to delete a scene'; end if;
  if p_expected_revision is null or p_expected_revision<1 then raise exception 'An explicit positive expected revision is required'; end if;
  select * into result from public.scenes where id=p_id and owner_id=auth.uid() for update;
  if not found then return; end if;
  if result.revision<>p_expected_revision then raise exception using errcode='40001',message='Scene changed on another device. Refresh before deleting',detail=public.scene_conflict_details(p_id,p_expected_revision,result)::text; end if;
  delete from public.scenes where id=p_id;
end;
$$;

create or replace function public.restore_workspace_scene(p_id uuid,p_revision integer,p_expected_revision integer,p_write_id uuid)
returns public.scenes language plpgsql security definer set search_path='' as $$
declare head public.scenes; source public.scene_revisions; document jsonb; result public.scenes;
begin
  if auth.uid() is null then raise exception 'Sign in to restore a scene'; end if;
  if p_revision is null or p_revision<1 or p_expected_revision is null or p_expected_revision<1 or p_write_id is null then raise exception 'Invalid restore request'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
  select * into head from public.scenes where id=p_id and owner_id=auth.uid() for update;
  if not found then raise exception 'Scene not found or access denied'; end if;
  select * into source from public.scene_revisions where scene_id=p_id and revision=p_revision and owner_id=auth.uid();
  if not found then raise exception 'Scene revision not found'; end if;
  document:=jsonb_set(source.document,'{authoring}',jsonb_build_object('via','restore','restored_from_revision',p_revision));
  -- save_workspace_scene performs retry identity, locked base checks, and all
  -- reference validation. A failed restore rolls back the new snapshot as well.
  select * into result from public.save_workspace_scene(p_id,source.name,document,p_expected_revision,p_write_id);
  return result;
end;
$$;


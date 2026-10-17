-- v1.3: private bucket for log photos. Path: <user_id>/<YYYY-MM-DD>/<uuid>.jpg
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('log-photos', 'log-photos', false, 6291456, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "log_photos_select" on storage.objects;
create policy "log_photos_select" on storage.objects for select to authenticated
  using (bucket_id = 'log-photos' and (((storage.foldername(name))[1] = auth.uid()::text and public.is_active()) or public.is_admin()));
drop policy if exists "log_photos_insert" on storage.objects;
create policy "log_photos_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'log-photos' and (storage.foldername(name))[1] = auth.uid()::text and public.is_active());
drop policy if exists "log_photos_delete" on storage.objects;
create policy "log_photos_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'log-photos' and (storage.foldername(name))[1] = auth.uid()::text and public.is_active());

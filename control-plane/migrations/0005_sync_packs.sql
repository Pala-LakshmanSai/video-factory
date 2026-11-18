-- Small synced files are stored packed together in one release asset (GitHub limits how many uploads an account
-- may make per hour). off = byte offset of the file inside its pack asset; NULL = the asset is the whole file.
ALTER TABLE sync_files ADD COLUMN off INTEGER;

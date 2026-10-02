INSERT OR IGNORE INTO plans(id,scope_type) VALUES ('starter','account'),('reseller','reseller');
INSERT OR IGNORE INTO resellers(id,name,status,plan_id,created_at) VALUES ('reseller-a','Local Hosting','ACTIVE','reseller',datetime('now')),('reseller-b','Other Hosting','ACTIVE','reseller',datetime('now'));
INSERT OR IGNORE INTO accounts(id,reseller_id,name,status,plan_id,created_at) VALUES ('account-a','reseller-a','Account A','ACTIVE','starter',datetime('now')),('account-b','reseller-b','Account B','ACTIVE','starter',datetime('now'));
INSERT OR IGNORE INTO hostnames(hostname,reseller_id,status) VALUES ('localhost','reseller-a','ACTIVE'),('a.local.test','reseller-a','ACTIVE'),('b.local.test','reseller-b','ACTIVE'),('platform.local.test',NULL,'ACTIVE');
INSERT OR IGNORE INTO users(id,email,created_at) VALUES ('local-owner','developer@local.test',datetime('now')),('other-owner','other@local.test',datetime('now')),('platform-owner','platform@local.test',datetime('now'));
INSERT OR IGNORE INTO role_assignments VALUES ('local-owner','account','account-a','owner'),('local-owner','reseller','reseller-a','owner'),('other-owner','account','account-b','owner'),('platform-owner','platform','platform','owner');

UPDATE users SET email_verified_at=datetime('now');

UPDATE plans SET rate=50 WHERE id='reseller';

-- 角色升级：@admin 升为超管（superadmin）
-- 权限模型：user < admin < superadmin
--   超管：授权管理员、删除账号、其他全部管理能力
--   管理员：来信 / 公告 / 封禁 / 重置密码，不能授权、不能删号
UPDATE users SET role = 'superadmin' WHERE username = 'admin' AND role = 'admin';

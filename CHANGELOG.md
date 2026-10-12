# Changelog / 更新记录

## 0.1.1 — 2026-10-13

- Read following profiles directly in pages of up to 200, reducing requests and removing the need to capture a Following GraphQL template.
- Filter accounts not following back with a dual-handle follower-count slider, precise numeric bounds and reset. Includes English and Simplified Chinese, keyboard controls and range validation.
- Exclude unknown follower counts when a range is active; clear previous selections when changing filters.
- Derive ZIP filenames from the extension version and check that package and manifest versions match.

中文：

- 关注列表改为每页最多 200 位的直接资料读取，减少请求，无需捕获 Following GraphQL 模板。
- 未回关页面新增双滑块粉丝数筛选、精确数字上下限及重置，支持中英文、键盘操作和范围校验。
- 启用粉丝数范围时排除未知计数；更改筛选时清空旧选择。
- ZIP 文件名自动跟随版本号，并检查 package 与 manifest 版本一致。

No new permissions, production dependencies or changes to unfollow execution. X interfaces can still change or rate-limit reads.

没有新增权限或生产依赖，没有修改取关执行逻辑。X 接口仍可能变化或限制读取频率。

## 0.1.0 — 2026-10-08

Initial release: bilingual relationship browsing, protection lists, full refresh, reviewed single/batch unfollows, and optional TwitterAPI.io reads with a user-provided key.

首次发布：双语关注关系浏览、保护名单、完整刷新、复核后的单个/批量取关，以及自备 Key 的可选 TwitterAPI.io 读取。

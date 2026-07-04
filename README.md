# 泰语沉浸播放器 YouTube 自动解析版

这个版本在原来的静态网页上增加了后端接口：

- 粘贴 YouTube 链接
- 后端读取视频字幕
- 如果配置 `OPENAI_API_KEY`，自动生成中文翻译、罗马音、单词拆解和例句
- 前端自动刷新学习页/歌曲页卡片

## 部署方式

推荐部署到 Vercel，因为 GitHub Pages 不能运行 `/api/analyze` 后端接口。

1. 上传整个 `thai-immersion-youtube-auto` 文件夹到 GitHub 仓库。
2. 在 Vercel 导入这个仓库。
3. 在 Vercel 项目设置里添加环境变量：
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL`，可选，默认 `gpt-4o-mini`
4. 部署完成后打开 Vercel 给的网址。

## 第一版限制

- 优先支持有字幕的 YouTube 视频。
- 如果视频没有可读取字幕，会提示粘贴泰语字幕/歌词。
- B站、TikTok、抖音等平台暂未接入。
- 如果没有配置 `OPENAI_API_KEY`，只能读取字幕，中文翻译和拆词会显示为待配置。

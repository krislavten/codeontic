---
"codeontic": patch
---

package.json 补 `repository` / `homepage` / `bugs`——没有 repository 字段时，npm 包页无法把 README 里的相对图片路径重写到仓库，导致全部图片裂图。

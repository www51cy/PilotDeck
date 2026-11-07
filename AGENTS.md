# Agent 文件落位规则

本仓库的目录责任与证据生命周期见 `docs/repository-organization.zh.md`。新增、移动或提交文件前必须遵守以下硬规则。

## 硬规则

1. 手写持久资产（源码、测试、文档、策略）在创建时直接进入正式目录，不得先进 `tmp/` 或 `artifacts/`。
2. `tmp/`、`artifacts/` 只放一次性或生成产物，不得包含需要 Git 跟踪的文件。
3. 禁止用 `git add -f` 绕过 `.gitignore` 把文件放进上述目录。
4. 已跟踪文件的迁移用 `git mv`；不要指望修改 `.gitignore` 取消已有跟踪。
5. 敏感数据默认仓库外；目录被忽略不代表安全，不得据此让敏感数据入库。
6. 检查只报告问题，不删除、移动或暂存文件；迁移、保留和清理分别作为明确操作执行。

## 落位选择

- 业务源码/测试：对应 `src/`、`tests/`、`ui/` 子树。
- 长期文档与已晋级证据：`docs/`，能力证据用 `docs/capability-alignment/evidence/`，问题证据用 `docs/issues/evidence/`。
- 本次运行的生成物：`artifacts/<run-id>/`（未跟踪）。
- 临时探针、草稿、可丢弃日志：`tmp/`（未跟踪）。
- 敏感原始数据：仓库外。

## 证据

- 生成物先落 `artifacts/<run-id>/` 或仓库外；手写文档、测试和策略直接进正式目录。
- 需要长期引用的生成证据经审查后移入 `docs/.../evidence/`，再用 `git mv` 纳入跟踪。
- 文档记录哈希后不得编辑该证据字节；目录移动可以，重跑请新增文件。
- 归档脚本按原字节保留，不保证在新目录下相对导入仍可运行。

## 提交前人工核对

```bash
git status --short
git check-ignore -v --no-index <待检查路径>
git ls-files tmp/ artifacts/
git ls-files -ci --exclude-standard
```

核对只报告问题。有误分类时先修正落位，不要删除规则、放宽忽略或强制暂存。

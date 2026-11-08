# 目录组织约定

最后更新：2026-11-07

本文件约定仓库内文件的落位、生命周期与 Git 边界。目标是让新增文件先被正确分类，而不是事后从混合目录里挑选。

## 五条约定

1. **目录名表达用途与责任。** 目录名应能直接回答“放什么、由谁维护”，避免 `misc/`、`stuff/`、`temp/` 这类无责任名称。
2. **持久资产与临时产物分目录。** 需要长期维护的资产与可再生成的运行产物、一次性临时文件必须分目录。`tmp/`、`artifacts/` 不得包含需要 Git 跟踪的文件；手写持久资产应在创建时直接进入正式目录，不得先放入临时目录等待整理。
3. **Git 规则与目录责任一致。** 需要忽略的目录应整目录忽略，正式资产目录默认纳入 Git 管理；忽略规则应准确限定路径，避免误伤其他层级的同名目录。`.gitignore` 只影响未跟踪文件，不能解除已有跟踪；已误跟踪文件必须显式迁移或取消跟踪。
4. **敏感数据不因忽略而豁免。** 真实用户数据、凭据、原始 transcript、HAR、wire capture 默认放仓库外。目录被忽略不代表内容安全，不得因此允许敏感数据进入仓库。
5. **检查与文件操作分离。** 检查只识别和报告错误分类、跟踪状态和忽略问题；不得由检查步骤自动删除、移动或暂存文件。迁移、长期保留和清理由明确操作单独完成。

## 目录责任

| 目录 | 责任 | 是否跟踪 |
|---|---|---|
| `src/` | 生产源码 | 是 |
| `tests/` | 自动化测试 | 是 |
| `ui/` | Web/桌面界面与本地服务 | 是 |
| `scripts/` | 仓库维护脚本 | 是 |
| `docs/` | 持久文档与已晋级证据 | 是 |
| `docs/capability-alignment/evidence/` | 能力验收的已晋级证据 | 是 |
| `docs/issues/evidence/` | 缺陷修复的已晋级证据 | 是 |
| `artifacts/` | 仓库根的一次运行输出，按 `artifacts/<run-id>/` 组织 | 否（根级已忽略） |
| `tmp/` | 仓库根的一次性本地草稿、探针、临时日志 | 否（根级已忽略） |
| 仓库外目录 | 敏感原始数据、未被审查的大体积抓包 | 不适用 |

说明：`/artifacts/` 与 `/tmp/` 都是根级规则，不会误伤 `src/session/artifacts/` 等嵌套同名目录。`docs/**/evidence/**` 作为正式资产，不受 `*.log` 等宽泛忽略规则影响。

## 分类决策

新增文件时按顺序判断：

1. **是业务源码或测试吗？** 放入对应 `src/` 或 `tests/` 子树。
2. **是长期维护的说明、设计或验收结论吗？** 放入 `docs/` 对应主题目录。
3. **是本次运行的原始输出或生成物吗？** 先放 `artifacts/<run-id>/`，保持未跟踪。
4. **是临时探针、草稿或可丢弃日志吗？** 放 `tmp/`，保持未跟踪。
5. **含令牌、私钥、Cookie、个人数据或完整原始抓包吗？** 默认放仓库外；确需入库必须先脱敏并单独审查。

第 1、2 类是手写持久资产，创建时直接进入正式目录；只有第 3 类生成物才先落 `artifacts/`，审查后再晋级。不要为了“先提交再说”把生成物放进 `docs/`，也不要为了“以后可能用”把持久资产留在 `tmp/`。

## 证据生命周期

0. **手写资产不入临时目录**：源码、测试、文档、策略在创建时直接进入正式目录。
1. **生成**：运行产物写入 `artifacts/<run-id>/` 或仓库外。
2. **审查**：确认结论、范围和脱敏边界。
3. **晋级**：需要长期引用的证据移入 `docs/.../evidence/` 并用 `git mv` 纳入跟踪。
4. **冻结**：一旦文档记录了证据哈希，不再编辑该证据字节；需要更新时重新运行并新增文件。

已晋级证据的哈希只由内容决定，目录移动不改变哈希。归档的探针脚本按原字节保存，不保证在新目录下相对导入仍可运行；需要重跑时从历史提交取原始路径版本。

## 2026-11-07 证据迁移映射

本次只迁移原 `tmp/` 下已跟踪的 37 个文件，未改动文件字节：

| 迁移前 | 迁移后 |
|---|---|
| `tmp/capability-alignment/auto-01-*` | `docs/capability-alignment/evidence/auto-01/` |
| `tmp/capability-alignment/exe-01-*` | `docs/capability-alignment/evidence/exe-01/` |
| `tmp/compaction-*`、`tmp/real-compaction-e2e-final.log`、`tmp/pilotdeck-real-compaction-e2e-aCEXGv/` | `docs/capability-alignment/evidence/compaction/` |
| `tmp/ui-001-*`、`tmp/ui-002-*` | `docs/issues/evidence/` |

被移动证据文件内部的旧绝对路径与旧 `tmp/...` 文字保持原样，用作历史运行记录；活文档中的引用已更新到新位置。

### 同批晋级的本地生成证据

以下 11 个文件原先只是 `tmp/` 下的未跟踪运行产物，但已被晋级后的证据叙述引用；为避免清理 `tmp/` 后引用悬空，按原字节晋级（未编辑内容）：

| 原 `tmp/` 位置 | 晋级后 |
|---|---|
| `tmp/compaction-baseline-results.invalid-fixtures.xml`、`tmp/compaction-baseline-results.before-positive-control.xml`、`tmp/compaction-candidate-before-prereg.patch`、`tmp/compaction-adjacent-final.log`、`tmp/auto-compaction-six-conflicts.log`、`tmp/probe-overflow-return.ts`、`tmp/real-compaction-e2e-rerun.log`、`tmp/probe-real-compaction-history.log`、`tmp/probe-real-compaction-history.ts`、`tmp/real-compaction-e2e-after-history-fix.log` | `docs/capability-alignment/evidence/compaction/local-runs/` |
| `tmp/pilotdeck-real-compaction-e2e-yeEANi/real-compaction-report.json` | `docs/capability-alignment/evidence/compaction/pilotdeck-real-compaction-e2e-yeEANi/` |

已记录哈希保持不变，例如候选补丁 `49c6654f260df26109e0230113a82e21252cff418eccd7c6a21edbe004e06a7d`、`yeEANi` 报告 `47cbd68369147c70409a492430f899a46b669085ef564b3b80983174c5ea7b07`。

同时清理了 `tmp/` 下两个残留 worktree（`compaction-final-isolated`、`compaction-prereg-baseline`）：它们的结论已进入上述已晋级证据，工作树本身只含 `node_modules` 链接和与主树逐字节一致的三份 prereg spec，无独立内容。敏感抓包 `ark-wire-requests.jsonl` 及其采集/回放脚本已移出仓库到 `/root/pilotdeck-private/captures/`（目录 700、文件 600）。

## 人工核对（暂不引入自动检查）

先按规则人工核对，使用一段时间后再评估是否引入自动检查。以下命令都是只读的：

```bash
# 当前未跟踪、已修改、已忽略的状态
git status --short

# 确认路径是否被忽略，以及命中哪条规则
git check-ignore -v --no-index tmp/foo.txt
git check-ignore -v --no-index src/session/artifacts/FileArtifact.ts

# 确认目录下是否已被跟踪
git ls-files tmp/ artifacts/
git ls-files docs/capability-alignment/evidence/compaction/

# 列出“已跟踪但命中忽略规则”的漂移，逐项判断
git ls-files -ci --exclude-standard
```

核对只报告问题；迁移、取消跟踪和清理分别作为明确操作执行，不在核对过程中顺带完成。

## 禁止事项

- 禁止 `git add -f` 把文件塞进 `tmp/` 或 `artifacts/`。
- 禁止通过修改 `.gitignore` 假装取消已有文件的跟踪。
- 禁止未脱敏的令牌、私钥、Cookie 或个人信息入库。
- 禁止在迁移或清理流程中顺带删除、移动或暂存无关文件。

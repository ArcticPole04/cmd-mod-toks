# cmd-mod-toks

[English](#english) · [简体中文](#简体中文)

---

## English

An honest tokens-per-second meter for [Command Code](https://commandcode.ai/docs/mods).

Speedometers tend to lie in one of two directions: divide a chunk count by 4 and CJK text reads 4×
too slow; count every frame as a token and short chunks read 4× too fast. This mod tries to be
right, and when it cannot be right it shows nothing rather than a plausible wrong number.

```
⚡ ~62.4 tok/s · writing      ← beside the working spinner, while streaming
⚡ 61.8 tok/s · 14:32         ← footer, once the request finishes
```

### Why another one

Several tok/s mods exist. This one differs in what it measures and what it refuses to show.

**Sampling.** The live rate is driven by `message_update`, which carries the *whole* partial
message rather than a delta. Three things follow:

- The count is invariant to how a provider fragments the stream. A provider sending 4 characters per
  frame and one sending 400 produce the same total.
- A mid-stream retry appears as a shrinking absolute count, so the window resets itself instead of
  counting withdrawn text twice.
- Tool-call arguments are counted. They are billed output tokens but never arrive as a `text_delta`,
  so delta-only meters undercount every tool-heavy turn.

**Script-aware estimation.** CJK characters count as one token, others as 1/3.6. A fixed
`characters / 4` under-reports Chinese by roughly 4×.

**Calibration against the provider.** Every request ends with the provider's own `outputTokens`,
which corrects the estimate for the next request. Providers disagree about whether reasoning tokens
are included in that figure, so both estimates are offered and whichever matches the reported count
more closely wins.

**Refusing to guess.** A rate above 400 tok/s means the provider buffered the reply and flushed it
in one burst, so the observed span is not a decode timeline. The reading is withheld rather than
clamped: a missing number is honest, a fabricated one is not.

### Install

```bash
cmd mods add cmd-mod-toks -g      # user scope, every project
cmd mods add cmd-mod-toks         # this project only
cmd mods list                     # confirm it registered
```

From a local checkout, before the package is published:

```bash
cmd mods add ArcticPole04/cmd-mod-toks -g
```

Requires Node 22.6 or newer. There is no build step; Command Code compiles the TypeScript at load.

### Commands and options

| Command | What it does |
|---|---|
| `/toks` | Report the last request: rate, tokens, total and decode time, time to first token |
| `/toks on` / `/toks off` | Show or hide every surface, without restarting |
| `/toks spinner` | Toggle just the live reading beside the spinner |
| `/toks status` | Toggle just the footer line |
| `/toks lang en` / `zh` | Switch the report language at runtime |

Launch-time defaults:

```bash
cmd --mod-option lang=en --mod-option spinner=false
```

`/toks` changes take effect immediately and survive a `/reload`; launch options only seed the
initial state.

### Reading the numbers

The live value carries a `~` because it is an estimate reconciled later against provider usage. The
footer value is exact: the provider's own count divided by the decode span.

| Field | Meaning |
|---|---|
| `~62.4 tok/s` | Live estimate over a 600ms window |
| `writing` / `thinking` | Whether the model is emitting text or reasoning |
| `stalled 2.3s` | No content for more than two seconds |
| `total 4.1s (decode 3.5s)` | Wall-clock request time, and the part spent decoding |
| `first token 812ms` | Wait before the first token arrived |
| `first token too late, timed the whole request` | The decode span was too short to trust |

The footer line stays language-neutral (`tok/s` plus a clock) because it shares space with the
host's own English segments. Everything the mod says on its own — the phase label, the `/toks`
report, notices — follows `lang`.

### Known limitations

These are deliberate, not oversights.

- **The first reading takes ~300ms.** It needs a window of frames before there is anything honest to
  average.
- **A buffered provider shows no live value at all.** If a provider or proxy hands over the whole
  reply at once, there is no decode timeline to measure: you get the final number and nothing live.
- **Requests decoding in under 250ms show only the final value.** There is no window to measure.
- **The opening frame is skipped.** Providers buffer reasoning before streaming starts — one measured
  run delivered 428 tokens in frame 0 against a median of 3 for the rest. Counting that as a delta
  would invent a huge rate, so frame 0 feeds the final calibration but not the live rate.
- **`⚡` occupies two columns on some terminals.** The footer truncates at the right edge regardless.
- **Calibration is per session, in memory.** A `/reload` keeps the last reading but resets the
  correction factor; it re-converges within a request or two.

### Development

```bash
npm test          # 89 unit tests, no runtime dependencies
npm run typecheck  # strict, needs typescript + @types/node
```

The mod is split so every calculation is testable without a host:

```
index.ts          event wiring only
src/events.ts     payload readers — the only place a host shape is trusted
src/measure.ts    every calculation, no host imports
src/format.ts     layout only; every string comes from src/copy.ts
src/copy.ts       the English and Chinese copy
src/persisted.ts  validation for values read back out of cmd.state
test/             unit tests over measure, format, events and persisted
```

Tests were written against real defects found while building this: retry double-counting, a
single-frame reasoning burst, CJK under-reporting, one-character deltas, missing usage, providers
that do not bill reasoning tokens, late first tokens, interruptions, and sparse streams. The
measurement guards are also mutation-tested — invert one and the suite fails.

### How this was written

The implementation was produced with an AI coding agent (Command Code) under human direction. The
product decisions, the measurement approach, the review standard and every design trade-off in this
repository were specified and reviewed by a person, and the code was written to that specification.
The test suite records the defects found during that process, including the ones the agent
introduced and then fixed.

Released under MIT. If you need an unambiguous copyright chain for a compliance purpose, treat this
as a source-available reference rather than a warranted grant.

### License

MIT. See [NOTICE.md](./NOTICE.md) for the prior work that informed the measurement guards.

---

## 简体中文

[Command Code](https://commandcode.ai/docs/mods) 的 token 吞吐计。

速度计通常朝两个方向撒谎：把 chunk 数除以 4，中文就少报约 4 倍；把每一帧都算作一个
token，短 chunk 就多报约 4 倍。这个 mod 力求准确，测不准时就不显示，而不是给一个看起来
很像真的错数。

```
⚡ ~62.4 tok/s · 输出          ← 流式期间，显示在工作转圈行右侧
⚡ 61.8 tok/s · 14:32          ← 请求结束后，显示在底栏
```

### 为什么再做一个

已经有好几个 tok/s mod。这个 mod 的区别在**测什么**和**拒绝显示什么**。

**采样方式。** 实时速率由 `message_update` 驱动，它携带的是**整条部分消息**而不是增量。
由此带来三点：

- 计数与 provider 如何切分流无关。每帧 4 个字符和每帧 400 个字符，总数相同。
- 断流重试表现为绝对值缩小，窗口因此自动重置，不会把撤回的文字数两遍。
- 工具调用参数会计入。它们是计费的输出 token，但从不以 `text_delta` 形式到达，只数 delta
  的 mod 会在每个工具密集的回合里少报。

**按字符类型估算。** 中日韩字符算 1 个 token，其余按 1/3.6。固定用 `字符数 / 4` 会让中文
少报约 4 倍。

**向 provider 校准。** 每次请求结束时都会带回 provider 自己的 `outputTokens`，用它修正下次
请求的估算。各家 provider 对「推理 token 是否计入该数值」并不一致，所以两个估算都参与比
较，谁与报出的数字更接近就用谁。

**拒绝猜测。** 速率超过 400 tok/s 说明 provider 把整段回复缓冲后一次吐出，观测到的跨度不
是解码时间线。此时**不显示**而不是钳制——没有数字是诚实的，编造的数字不是。

### 安装

```bash
cmd mods add cmd-mod-toks -g      # 用户级，所有项目生效
cmd mods add cmd-mod-toks         # 仅当前项目
cmd mods list                     # 确认已注册
```

在发布到 npm 之前，也可以直接从 GitHub 安装：

```bash
cmd mods add ArcticPole04/cmd-mod-toks -g
```

需要 Node 22.6 或更新版本。无需构建步骤，Command Code 在加载时编译 TypeScript。

### 命令与选项

| 命令 | 作用 |
|---|---|
| `/toks` | 报告上一次请求：速率、token 数、总耗时与解码耗时、首 token 时间 |
| `/toks on` / `/toks off` | 显示或隐藏所有界面，无需重启 |
| `/toks spinner` | 只切换转圈行旁的实时读数 |
| `/toks status` | 只切换底栏那一行 |
| `/toks lang en` / `zh` | 运行期切换报告语言 |

启动期的默认值：

```bash
cmd --mod-option lang=zh --mod-option spinner=false
```

`/toks` 的改动立即生效，并在 `/reload` 后保留；启动选项只设置初始状态。

### 怎么看这些数字

实时值带 `~`，因为它是估算值，之后会用 provider 的用量校正。底栏里的数字是准确的：用
provider 自己报的计数除以解码跨度。

| 字段 | 含义 |
|---|---|
| `~62.4 tok/s` | 600ms 窗口内的实时估算 |
| `输出` / `思考` | 模型当前在输出正文还是在推理 |
| `停滞 2.3s` | 超过两秒没有新内容 |
| `总 4.1s（解码 3.5s）` | 请求的实际耗时，以及其中用于解码的部分 |
| `首 token 812ms` | 第一个 token 到达前的等待时间 |
| `首 token 过晚，按整段耗时估算` | 解码跨度过短不可信，改用整段耗时 |

底栏那一行保持语言中性（只有 `tok/s` 和时钟），因为它要与宿主自带的英文段共用一行。
mod 自己说的话——阶段标签、`/toks` 报告、提示——都跟随 `lang`。

### 已知局限

以下都是有意的取舍，不是疏漏。

- **首个读数要等约 300ms。** 需要先攒够一个窗口的帧，才有可以诚实平均的东西。
- **缓冲型 provider 完全没有实时值。** 如果 provider 或代理把整段回复一次交出，就不存在可
  测量的解码时间线：你只会看到最终值。
- **解码短于 250ms 的请求只显示最终值。** 没有可测量的窗口。
- **首帧被跳过。** provider 在开始流式前会先缓冲推理内容——实测有一次第 0 帧就送来了 428
  个 token，而其余帧的中位数是 3。把它当作增量会凭空造出一个巨大速率，所以第 0 帧只参与
  最终校准，不计入实时速率。
- **`⚡` 在部分终端占两列。** 底栏照旧在右边缘截断。
- **校准按会话保存在内存。** `/reload` 会保留上一次的读数，但重置校正系数，通常一两次请
  求内就会重新收敛。

### 开发

```bash
npm test           # 89 个单元测试，无运行时依赖
npm run typecheck  # 严格模式，需要 typescript + @types/node
```

mod 被拆分得让每项计算都能脱离宿主测试：

```
index.ts          只做事件接线
src/events.ts     读取事件负载——唯一信任宿主数据结构的地方
src/measure.ts    所有计算，不导入宿主 API
src/format.ts     只负责排版；所有文案来自 src/copy.ts
src/copy.ts       英文与中文文案
src/persisted.ts  从 cmd.state 读回的值在此校验
test/             针对 measure、format、events、persisted 的单元测试
```

测试是针对开发过程中真实出现的缺陷写的：重试重复计数、单帧推理突发、中文少报、单字符
delta、缺失 usage、不把推理计入的 provider、首 token 过晚、中断、稀疏流。测量相关的守卫还
做了变异测试——反转任意一条，测试就会失败。

### 关于编写方式

本项目的实现由 AI 编码代理（Command Code）在人的指导下产出。产品决策、测量思路、评审标准，
以及仓库里每一处设计取舍，都由人提出并审定，代码是按这份规格写成的。测试套件记录了该过程中
发现的缺陷，包括代理自己引入、随后又修掉的那些。

以 MIT 发布。如果你的合规流程需要一条无歧义的版权链，请把它当作可获取源码的参考实现，而不是
一份带担保的授权。

### 许可

MIT。测量守卫所借鉴的先前工作见 [NOTICE.md](./NOTICE.md)。

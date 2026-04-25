# 架构演进与重构记录 (Aura Genesis)

## 总体目标
彻底重构现有的“巨石型” `App.tsx`，将其拆解为对 AI Agent 友好的、高度模块化、具有清晰边界和数据流的工程结构。确保 API 调用、状态管理和 UI 组件严格解耦，同时完全保留现有的视觉交互体验（Never break userspace）。

## 阶段一：顶层规划与架构设计 (TODO List)

### 1. 领域与类型 (Domain & Types)
- [ ] 提取共享类型：创建 `src/shared/types/`，定义 `ScentType`, `ScentProfile`, `ScentData`, `Message` 等核心数据结构。
- [ ] 领域数据中心化：将 `SCENT_PROFILES` 移出 UI 组件，作为静态领域数据管理。

### 2. 基础设施与适配器 (Infrastructure & Adapters)
- [ ] 隔离副作用：创建 `src/adapters/llm.ts` 或类似文件。
- [ ] 将 Gemini API 调用 (`ai.models.generateContent`) 封装为独立的适配器。UI 绝不允许直接调用 API。

### 3. 应用服务层 (Application Services)
- [ ] 状态与业务逻辑编排：引入清晰的状态管理（可通过自定义 Hook 或状态机），管理聊天历史和当前 Scent 状态，统一编排 API 调用。

### 4. UI 组件原子化 (UI Components)
- [ ] 提取 `AnimatedText`, `NoteCard`, `NeuralWaveform`, `NoiseOverlay`, `ScentVisualizer` 到 `src/ui/components/` 的独立文件中。
- [ ] 重构 `App.tsx`，使其仅作为组合根（Composition Root）存在。

## 当前周期记录
**工作**：项目初始审查与架构评估。
**发现**：
1. `App.tsx` 接近 1000 行，承担了从数据定义、AI API 通信、动画渲染到状态管理的所有职责。
2. 严重违反“单一职责”和“分层的单向数据流”原则。
**决策**：制定了模块化重构计划。
**状态**：计划已就绪，等待开发执行。

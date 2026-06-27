# Linting 和 Formatting 配置说明

本项目使用 [oxlint](https://oxc-project.github.io/docs/guide/linter/) 和 [oxfmt](https://oxc-project.github.io/docs/guide/formatter/) 进行代码检查和格式化。

## 可用命令

### 主项目（根目录）

- `pnpm lint` - 运行代码检查
- `pnpm lint:fix` - 运行代码检查并自动修复
- `pnpm format` - 格式化代码
- `pnpm format:check` - 检查代码格式

### Web 子项目

- `cd web && pnpm lint` - 运行 web 项目的代码检查
- `cd web && pnpm lint:fix` - 运行 web 项目的代码检查并自动修复
- `cd web && pnpm format` - 格式化 web 项目代码
- `cd web && pnpm format:check` - 检查 web 项目代码格式

### 统一命令

- `pnpm lint:all` - 同时运行主项目和 web 项目的代码检查
- `pnpm format:all` - 同时格式化主项目和 web 项目的代码

## 配置文件

### oxlint 配置 (.oxlintrc.json)

- **React 支持**：包含完整的 React Hooks、JSX 语法检查
- **TypeScript 支持**：类型安全和最佳实践检查
- **代码质量**：未使用变量、调试语句、代码风格等检查

#### 主要规则：

- **React**: hooks 依赖检查、JSX key 要求、属性验证等
- **TypeScript**: 不必要的类型断言、const 断言等
- **代码风格**: 禁用 var、推荐 const、模板字符串等

### oxfmt 配置 (.oxfmtrc.json)

- **React JSX 优化**：JSX 友好的格式化配置
- **代码风格**：单引号、尾随逗号、一致的缩进

#### 主要特性：

- 打印宽度：100 字符
- JSX 单引号：启用
- 智能换行：保持代码可读性

## 集成到开发流程

建议在提交代码前运行：

```bash
pnpm lint:all
pnpm format:all
```

或者在 pre-commit hook 中自动运行这些检查。

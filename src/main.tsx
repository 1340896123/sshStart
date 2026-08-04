import { Component, type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import App from "./App";
import { diagnosticError, installDiagnostics } from "./diagnostics";
import "./styles.css";

class RootErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    diagnosticError("react.render.error", error, { componentStack: errorInfo.componentStack });
  }

  render() {
    if (this.state.hasError) {
      return <main style={{ padding: 32, color: "#f4f4f4", background: "#282828", minHeight: "100vh" }}>应用界面发生异常，请保留当前日志并重启应用。</main>;
    }
    return this.props.children;
  }
}

installDiagnostics();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <RootErrorBoundary>
    <App />
  </RootErrorBoundary>,
);

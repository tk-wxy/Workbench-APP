export type NativeEvent<T> = { payload: T };
export type NativeEventHandler<T> = (event: NativeEvent<T>) => void | Promise<void>;
export type NativeEventRegistrar = <T>(eventName: string, handler: NativeEventHandler<T>) => Promise<void>;
export type NativeUnlisten = () => void;
export type NativeListen = <T>(eventName: string, handler: (event: NativeEvent<T>) => void) => Promise<NativeUnlisten>;

export type NativeEventScope = {
  ready: Promise<void>;
  dispose: () => void;
};

type NativeEventOptions = {
  loadListen?: () => Promise<NativeListen>;
  reportError?: (message: string, error: unknown) => void;
};

const loadTauriListen = async (): Promise<NativeListen> => {
  const { listen } = await import("@tauri-apps/api/event");
  return <T>(eventName: string, handler: (event: NativeEvent<T>) => void) =>
    listen<T>(eventName, event => handler(event));
};

const reportToConsole = (message: string, error: unknown) => console.error(message, error);

/**
 * Owns one effect's native event subscriptions.
 *
 * Registration stays sequential, a failed event does not block later events, and dispose is
 * safe even when StrictMode cleans the effect up before an awaited listen call completes.
 */
export function subscribeNativeEvents(
  configure: (register: NativeEventRegistrar) => void | Promise<void>,
  options: NativeEventOptions = {},
): NativeEventScope {
  const cleanup: NativeUnlisten[] = [];
  const reportError = options.reportError ?? reportToConsole;
  let disposed = false;

  const ready = (async () => {
    let listen: NativeListen;
    try {
      listen = await (options.loadListen ?? loadTauriListen)();
    } catch (error) {
      reportError("[events] 加载 Tauri 事件 API 失败：", error);
      return;
    }

    const register: NativeEventRegistrar = async <T>(eventName: string, handler: NativeEventHandler<T>) => {
      try {
        const unlisten = await listen<T>(eventName, event => {
          try {
            void Promise.resolve(handler(event)).catch(error => {
              reportError(`[events] 处理 ${eventName} 失败：`, error);
            });
          } catch (error) {
            reportError(`[events] 处理 ${eventName} 失败：`, error);
          }
        });
        if (disposed) unlisten();
        else cleanup.push(unlisten);
      } catch (error) {
        reportError(`[events] 注册 ${eventName} 失败：`, error);
      }
    };

    try {
      await configure(register);
    } catch (error) {
      reportError("[events] 配置事件监听失败：", error);
    }
  })();

  return {
    ready,
    dispose: () => {
      disposed = true;
      cleanup.splice(0).forEach(unlisten => unlisten());
    },
  };
}

import { lazy, Suspense, type ComponentType } from "react";

export default function dynamic<T extends ComponentType<any>>(
  loader: () => Promise<{ default: T } | T>,
  options?: { loading?: ComponentType; ssr?: boolean },
) {
  const Lazy = lazy(async () => {
    const loaded = await loader();
    return typeof loaded === "object" && loaded && "default" in loaded
      ? loaded as { default: T }
      : { default: loaded as T };
  });
  return function DynamicComponent(props: React.ComponentProps<T>) {
    const Loading = options?.loading;
    const Component = Lazy as ComponentType<any>;
    return <Suspense fallback={Loading ? <Loading /> : null}><Component {...props} /></Suspense>;
  };
}

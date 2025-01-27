import {DEFAULT_POLYFILL_OPTIONS, getCompletePolyfill, getPolyfill, NavigationPolyfillOptions} from "./get-polyfill";
import {getNavigation} from "./get-navigation";
import {globalNavigation} from "./global-navigation";

export function applyPolyfill(options: NavigationPolyfillOptions = DEFAULT_POLYFILL_OPTIONS) {
  const { apply, navigation } = getCompletePolyfill(options);
  apply();
  return navigation;
}

export function shouldApplyPolyfill(navigation = getNavigation()) {
  return (
      navigation !== globalNavigation &&
      !Object.hasOwn(globalThis, 'navigation') &&
      typeof window !== "undefined"
  );
}

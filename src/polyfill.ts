import { getNavigation } from "./get-navigation";
import { applyPolyfill, shouldApplyPolyfill } from "./apply-polyfill";
import { setSerializer } from "./util/serialization";

const navigation = getNavigation();

if (shouldApplyPolyfill(navigation)) {
  try {
    applyPolyfill({
      navigation
    });
  } catch (error) {
    console.error("Failed to apply polyfill");
    console.error(error);
  }
}

export {
  setSerializer
}
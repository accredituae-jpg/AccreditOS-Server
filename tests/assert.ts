export function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILURE: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  } else {
    console.log(`✅ SUCCESS: ${message}`);
  }
}

export function assertThrows(fn: () => any | Promise<any>, expectedErrorContains: string, message: string) {
  try {
    const res = fn();
    if (res && typeof res.then === "function") {
      return res.then(
        () => {
          console.error(`❌ FAILURE: Expected exception not thrown: ${message}`);
          throw new Error(`Expected exception not thrown: ${message}`);
        },
        (err: any) => {
          if (err.message && err.message.includes(expectedErrorContains)) {
            console.log(`✅ SUCCESS: Threw expected exception containing "${expectedErrorContains}": ${message}`);
          } else {
            console.error(`❌ FAILURE: Expected exception containing "${expectedErrorContains}", but got "${err.message}": ${message}`);
            throw err;
          }
        }
      );
    } else {
      console.error(`❌ FAILURE: Expected exception not thrown: ${message}`);
      throw new Error(`Expected exception not thrown: ${message}`);
    }
  } catch (err: any) {
    if (err.message && err.message.includes(expectedErrorContains)) {
      console.log(`✅ SUCCESS: Threw expected exception containing "${expectedErrorContains}": ${message}`);
    } else {
      console.error(`❌ FAILURE: Expected exception containing "${expectedErrorContains}", but got "${err.message}": ${message}`);
      throw err;
    }
  }
}

import Constants from "expo-constants";

// Where the SafeTemp server is.
// Builds set EXPO_PUBLIC_SAFETEMP_URL in eas.json (the hosted https:// address).
// Testing in Expo Go: the same computer that's running Expo, found automatically on whatever
// Wi-Fi or hotspot you're on (the server runs there with `npm start` in the web folder).
const devHost = (Constants.expoConfig?.hostUri || "").split(":")[0];

export const SAFETEMP_URL = process.env.EXPO_PUBLIC_SAFETEMP_URL || (devHost ? `http://${devHost}:5180/` : "http://192.168.1.32:5180/");

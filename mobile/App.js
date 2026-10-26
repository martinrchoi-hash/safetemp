// SafeTemp phone app: the SafeTemp web app full-screen, plus what a phone does better than a
// web page: its own GPS, and real push notifications for official weather alerts.
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import { AndroidImportance } from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { SAFETEMP_URL } from "./config";

// Alerts that arrive while the app is open still show as a banner.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

// Ask permission and get this phone's push address (an Expo push token) for the SafeTemp server.
async function getPushToken() {
  if (!Device.isDevice) throw new Error("Alerts only work on a real phone, not a simulator.");
  if (Platform.OS === "android") {
    // Android shows the permission prompt only once a channel exists.
    await Notifications.setNotificationChannelAsync("alerts", {
      name: "Weather alerts",
      importance: AndroidImportance.HIGH,
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") ({ status } = await Notifications.requestPermissionsAsync());
  if (status !== "granted") throw new Error("Notifications are off for SafeTemp. Turn them on in your phone's Settings, then try again.");
  const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
  if (!projectId) throw new Error("Alerts aren't set up in this build yet.");
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  return data;
}

export default function App() {
  const web = useRef(null);
  const [failed, setFailed] = useState(false);

  const run = (js) => web.current?.injectJavaScript(`${js}; true;`);

  // The page asked for the location: ask the phone, then pass it back (or say it's off).
  const sendLocation = useCallback(async () => {
    try {
      const { granted } = await Location.requestForegroundPermissionsAsync();
      if (!granted) return run("window.safeTempNativeLocation && window.safeTempNativeLocation(null, null)");
      const { coords } = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      run(`window.safeTempNativeLocation && window.safeTempNativeLocation(${coords.latitude}, ${coords.longitude})`);
    } catch {
      run("window.safeTempNativeLocation && window.safeTempNativeLocation(null, null)");
    }
  }, []);

  // The page asked to turn on alerts: hand back the push token, or why there isn't one.
  const sendPushToken = useCallback(async () => {
    try {
      const token = await getPushToken();
      run(`window.safeTempNativePush && window.safeTempNativePush(${JSON.stringify(token)}, null)`);
    } catch (err) {
      run(`window.safeTempNativePush && window.safeTempNativePush(null, ${JSON.stringify(String(err.message || err))})`);
    }
  }, []);

  const onMessage = useCallback(
    (event) => {
      const message = event.nativeEvent.data;
      if (message === "locate") sendLocation();
      if (message === "push-token") sendPushToken();
    },
    [sendLocation, sendPushToken]
  );

  // Tapping an alert opens the app: refresh the page so it shows the latest check.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(() => web.current?.reload());
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
        <StatusBar style="dark" />
        {failed ? (
          <View style={styles.error}>
            <Text style={styles.errorTitle}>Can&apos;t reach SafeTemp</Text>
            <Text style={styles.errorText}>
              Check your internet connection and try again.{"\n\n"}
              {SAFETEMP_URL}
            </Text>
            <Pressable style={styles.button} onPress={() => setFailed(false)}>
              <Text style={styles.buttonText}>Try again</Text>
            </Pressable>
          </View>
        ) : (
          <WebView
            ref={web}
            source={{ uri: SAFETEMP_URL }}
            style={styles.screen}
            onMessage={onMessage}
            onError={() => setFailed(true)}
            onHttpError={(e) => e.nativeEvent.statusCode >= 500 && setFailed(true)}
            pullToRefreshEnabled
            allowsBackForwardNavigationGestures
            setSupportMultipleWindows={false}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#edf1f5" },
  error: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28 },
  errorTitle: { fontSize: 22, fontWeight: "700", color: "#172230", marginBottom: 10 },
  errorText: { fontSize: 15, lineHeight: 22, color: "#45535f", textAlign: "center", marginBottom: 20 },
  button: { backgroundColor: "#2266b8", paddingVertical: 12, paddingHorizontal: 22, borderRadius: 12 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});

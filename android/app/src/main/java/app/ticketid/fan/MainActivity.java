package app.ticketid.fan;

import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import org.json.JSONObject;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.google.firebase.FirebaseApp;
import com.google.firebase.appcheck.FirebaseAppCheck;
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory;
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory;
import java.util.UUID;

public class MainActivity extends BridgeActivity {
    private int statusInset;
    private int navigationInset;
    private String deviceId = "";
    private String appCheckToken = "";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        deviceId = loadDeviceId();
        startAppCheck();
        WebView bridgeView = getBridge() == null ? null : getBridge().getWebView();
        if (bridgeView != null) {
            bridgeView.addJavascriptInterface(new TicketIdBridge(), "TicketIdNative");
        }
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.setAppearanceLightStatusBars(false);
            controller.setAppearanceLightNavigationBars(false);
        }
        WebView webView = getBridge().getWebView();
        webView.setBackgroundColor(0xFF0E3338);
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            statusInset = bars.top;
            navigationInset = bars.bottom;
            publishInsets();
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(webView);
        deliverResetLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        deliverResetLink(intent);
    }

    private void deliverResetLink(Intent intent) {
        if (intent == null || intent.getData() == null) return;
        Uri data = intent.getData();
        String host = data.getHost() == null ? "" : data.getHost();
        String path = data.getPath() == null ? "" : data.getPath();
        if (!path.startsWith("/reset")) return;
        if (!host.equals("ticketid-ab43c.web.app") && !host.equals("ticketid-ab43c.firebaseapp.com")) return;
        String code = data.getQueryParameter("oobCode");
        if (code == null || code.isEmpty()) return;
        String script = "window.__ticketidReset=" + JSONObject.quote(code)
            + ";window.dispatchEvent(new CustomEvent('ticketid-reset',{detail:window.__ticketidReset}))";
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null) return;
        webView.post(() -> webView.evaluateJavascript(script, null));
        webView.postDelayed(() -> webView.evaluateJavascript(script, null), 600);
    }

    @Override
    public void onResume() {
        super.onResume();
        publishInsets();
        refreshAppCheck();
    }

    private String loadDeviceId() {
        SharedPreferences prefs = getSharedPreferences("ticketid", MODE_PRIVATE);
        String stored = prefs.getString("deviceId", "");
        if (stored != null && stored.length() >= 8) return stored;
        String androidId = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
        String next = androidId != null && androidId.length() >= 8 ? androidId : UUID.randomUUID().toString();
        prefs.edit().putString("deviceId", next).apply();
        return next;
    }

    private void startAppCheck() {
        try {
            if (FirebaseApp.getApps(this).isEmpty()) FirebaseApp.initializeApp(this);
            FirebaseAppCheck check = FirebaseAppCheck.getInstance();
            if (BuildConfig.DEBUG) {
                check.installAppCheckProviderFactory(DebugAppCheckProviderFactory.getInstance());
            } else {
                check.installAppCheckProviderFactory(PlayIntegrityAppCheckProviderFactory.getInstance());
            }
            refreshAppCheck();
        } catch (Exception ignored) {
            /* Play Integrity is unavailable until the app is registered. */
        }
    }

    private void refreshAppCheck() {
        try {
            FirebaseAppCheck.getInstance().getAppCheckToken(false)
                .addOnSuccessListener(result -> appCheckToken = result.getToken());
        } catch (Exception ignored) {
            /* Login still works; the server only requires this token when enforcement is on. */
        }
    }

    public class TicketIdBridge {
        @JavascriptInterface
        public String getDeviceId() {
            return deviceId;
        }

        @JavascriptInterface
        public String getAppCheckToken() {
            return appCheckToken;
        }
    }

    private void publishInsets() {
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null) return;
        float density = getResources().getDisplayMetrics().density;
        float top = statusInset / density;
        float bottom = navigationInset / density;
        webView.post(() -> webView.evaluateJavascript(
            "document.documentElement.style.setProperty('--safe-top','" + top + "px');"
                + "document.documentElement.style.setProperty('--safe-bottom','" + bottom + "px')",
            null));
    }
}

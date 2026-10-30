package app.ticketid.receiver;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private int statusInset;
    private int navigationInset;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.setAppearanceLightStatusBars(false);
            controller.setAppearanceLightNavigationBars(false);
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.CAMERA}, 1);
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
    }

    @Override
    public void onResume() {
        super.onResume();
        publishInsets();
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

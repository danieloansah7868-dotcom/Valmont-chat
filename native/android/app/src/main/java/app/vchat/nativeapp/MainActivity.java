package app.vchat.nativeapp;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends AppCompatActivity {
    private static final int FILE_CHOOSER = 71;
    private static final int PERMISSIONS = 72;
    private static final String PREFS = "vchat.native";
    private static final String PREF_URL = "serverUrl";

    private WebView webView;
    private View setup;
    private ValueCallback<Uri[]> filePathCallback;
    private PermissionRequest pendingWebPermission;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        webView = findViewById(R.id.webview);
        setup = findViewById(R.id.setup);
        configureWebView();

        findViewById(R.id.open_app).setOnClickListener(v -> {
            EditText field = findViewById(R.id.server_url);
            if (openServer(field.getText().toString(), true)) return;
            Toast.makeText(this, R.string.server_prompt_error, Toast.LENGTH_SHORT).show();
        });

        String baked = firstNonBlank(BuildConfig.VCHAT_SERVER_URL, getString(R.string.vchat_server_url));
        String stored = getSharedPreferences(PREFS, MODE_PRIVATE).getString(PREF_URL, "");
        if (!openServer(firstNonBlank(baked, stored), false)) {
            showSetup(firstNonBlank(baked, stored));
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setUserAgentString(settings.getUserAgentString() + " VChatNative/1.0 Android");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    return true;
                }
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                Intent intent = params.createIntent();
                try {
                    startActivityForResult(intent, FILE_CHOOSER);
                    return true;
                } catch (Exception error) {
                    filePathCallback = null;
                    return false;
                }
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                pendingWebPermission = request;
                requestRuntimePermissions(request.getResources());
            }
        });
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setMimeType(mimeType);
            request.addRequestHeader("cookie", CookieManager.getInstance().getCookie(url));
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, URLUtil.guessFileName(url, contentDisposition, mimeType));
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (manager != null) manager.enqueue(request);
        });
    }

    private boolean openServer(String raw, boolean persist) {
        String url = normalizeUrl(raw);
        if (url == null) return false;
        if (persist) {
            SharedPreferences.Editor editor = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
            editor.putString(PREF_URL, url);
            editor.apply();
        }
        setup.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(url);
        return true;
    }

    private void showSetup(String existing) {
        webView.setVisibility(View.GONE);
        setup.setVisibility(View.VISIBLE);
        EditText field = findViewById(R.id.server_url);
        if (existing != null && !existing.trim().isEmpty()) field.setText(existing);
    }

    private void requestRuntimePermissions(String[] webResources) {
        List<String> needed = new ArrayList<>();
        boolean camera = false;
        boolean mic = false;
        if (webResources != null) {
            for (String resource : webResources) {
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) camera = true;
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) mic = true;
            }
        }
        if (camera && ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.CAMERA);
        }
        if (mic && ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.RECORD_AUDIO);
        }
        if (needed.isEmpty()) {
            grantPendingWebPermission();
            return;
        }
        ActivityCompat.requestPermissions(this, needed.toArray(new String[0]), PERMISSIONS);
    }

    private void grantPendingWebPermission() {
        if (pendingWebPermission == null) return;
        pendingWebPermission.grant(pendingWebPermission.getResources());
        pendingWebPermission = null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != PERMISSIONS) return;
        if (pendingWebPermission == null) return;
        boolean granted = true;
        for (int result : grantResults) {
            if (result != PackageManager.PERMISSION_GRANTED) granted = false;
        }
        if (granted) grantPendingWebPermission();
        else {
            pendingWebPermission.deny();
            pendingWebPermission = null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER || filePathCallback == null) return;
        Uri[] result = resultCode == Activity.RESULT_OK ? WebChromeClient.FileChooserParams.parseResult(resultCode, data) : null;
        filePathCallback.onReceiveValue(result);
        filePathCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (webView.getVisibility() == View.VISIBLE && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        CookieManager.getInstance().flush();
        super.onDestroy();
    }

    private static String firstNonBlank(String... values) {
        if (values == null) return "";
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) return value.trim();
        }
        return "";
    }

    private static String normalizeUrl(String raw) {
        if (raw == null) return null;
        String value = raw.trim();
        if (value.isEmpty()) return null;
        if (!value.startsWith("http://") && !value.startsWith("https://")) value = "https://" + value;
        Uri uri = Uri.parse(value);
        String scheme = uri.getScheme();
        if (uri.getHost() == null) return null;
        if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
        return value;
    }
}

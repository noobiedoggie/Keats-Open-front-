package io.keats.openfrontautopilot;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/**
 * Hosts openfront.io in a full-screen WebView and injects the autopilot
 * userscript into it, so the app runs the exact same brain as the
 * Tampermonkey version. The script reads the live game state from the page
 * and sends actions through the game's own event bus, which is far more
 * precise than tapping on the screen.
 */
public class MainActivity extends Activity {

    private static final String HOME = "https://openfront.io/";
    private static final String SCRIPT_ASSET = "openfront-autopilot.user.js";

    private WebView web;
    private String script;
    private boolean documentStartInjection;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // AFK play needs the screen (and therefore the page) to stay alive.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        script = loadScript();
        createWebView();
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl(HOME);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0F141C"));
        setContentView(web);
        goImmersive();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // the bot's settings + game progress live in localStorage
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setSupportMultipleWindows(false); // pop-ups open in place
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        // Present as normal mobile Chrome rather than an embedded WebView.
        s.setUserAgentString(s.getUserAgentString().replace("; wv", ""));

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);

        // Preferred: inject before any page script runs, on every navigation.
        documentStartInjection = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
        if (documentStartInjection && script != null) {
            Set<String> origins = new HashSet<>();
            origins.add("https://openfront.io");
            origins.add("https://*.openfront.io");
            WebViewCompat.addDocumentStartJavaScript(web, script, origins);
        }

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                // The game and its Discord sign-in stay in the app, so the
                // account is signed in here and not in the phone's browser.
                if (isInAppUrl(uri) || !request.isForMainFrame()) return false;
                if (isGoogleSignIn(uri)) {
                    // Google refuses sign-in inside an embedded WebView
                    // (disallowed_useragent), and in the browser it would
                    // sign in the browser, not the app.
                    Toast.makeText(MainActivity.this,
                            "Google sign-in doesn't work inside the app. Use Discord.",
                            Toast.LENGTH_LONG).show();
                    String current = view.getUrl();
                    if (current == null || current.contains("/auth/login/")) view.loadUrl(HOME);
                    return true;
                }
                // Anything else (store links…) goes to the browser.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                    return false;
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // Fallback for old WebView versions without document-start scripts.
                // The script guards itself against running twice.
                if (!documentStartInjection && script != null && url != null && isGameUrl(Uri.parse(url))) {
                    view.evaluateJavascript(script, null);
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The page crashed or was killed for memory: rebuild it and carry on.
                if (web != null) {
                    web.destroy();
                    web = null;
                }
                createWebView();
                web.loadUrl(HOME);
                return true;
            }
        });
    }

    private static boolean isInAppUrl(Uri uri) {
        if (isGameUrl(uri)) return true;
        String host = uri.getHost();
        if (host == null) return false;
        // Discord's OAuth pages (login, authorize, captcha) during sign-in.
        return host.equals("discord.com") || host.endsWith(".discord.com")
                || host.equals("discordapp.com") || host.endsWith(".discordapp.com");
    }

    private static boolean isGoogleSignIn(Uri uri) {
        String host = uri.getHost();
        return host != null && host.equals("accounts.google.com");
    }

    private static boolean isGameUrl(Uri uri) {
        String host = uri.getHost();
        if (host == null) return false;
        return host.equals("openfront.io") || host.endsWith(".openfront.io")
                // Cloudflare's browser check runs on its own domain.
                || host.endsWith("cloudflare.com");
    }

    private String loadScript() {
        try (InputStream in = getAssets().open(SCRIPT_ASSET)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            Toast.makeText(this, "Autopilot script missing from the app", Toast.LENGTH_LONG).show();
            return null;
        }
    }

    @SuppressWarnings("deprecation")
    private void goImmersive() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) goImmersive();
    }

    // The WebView is deliberately NOT paused in onPause(), so the bot keeps
    // thinking if another window briefly covers the app. Cookies (the signed-in
    // session) are written to disk right away, so closing the app keeps the
    // account signed in.
    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onStop() {
        super.onStop();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        new AlertDialog.Builder(this)
                .setMessage("Quit OpenFront Autopilot?")
                .setPositiveButton("Quit", (d, w) -> finish())
                .setNegativeButton("Stay", null)
                .show();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}

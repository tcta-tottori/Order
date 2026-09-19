package jp.tcta.orderview;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

/**
 * Web アプリ一式 (assets/www) をそのまま抱えた WebView。
 * 通信は「新しい版が出ていないか」を見に行くときだけで、表の解析は端末内で完結する。
 */
public class MainActivity extends Activity {

  /** assets を https で配る。file:// と違って生成元が固定されるので保存した設定が残る。 */
  static final String ORIGIN = "https://appassets.androidplatform.net";
  static final String START_URL = ORIGIN + "/assets/www/index.html";
  private static final int REQ_PICK_FILE = 4101;

  private WebView web;
  private ValueCallback<Uri[]> pendingPick;

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);

    web = new WebView(this);
    web.setLayoutParams(new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    setContentView(web);

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setSupportZoom(false);
    s.setBuiltInZoomControls(false);
    // 画面の文字の大きさはアプリ側の設定で決める。端末のフォント倍率と二重に掛からないようにする。
    s.setTextZoom(100);
    s.setCacheMode(WebSettings.LOAD_DEFAULT);

    final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
        .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
        .build();

    web.setWebViewClient(new WebViewClient() {
      @Override
      public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
        return loader.shouldInterceptRequest(req.getUrl());
      }

      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
        return openOutside(req.getUrl());
      }
    });

    web.setWebChromeClient(new WebChromeClient() {
      @Override
      public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
        if (pendingPick != null) pendingPick.onReceiveValue(null);
        pendingPick = cb;
        // 種類で絞り込まない。Google ドライブなどは .xlsm の種類の綴りが揃っておらず、
        // 絞り込むと肝心の発注マクロが選べなくなる。開けない中身なら読み込み時に知らせる。
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        pick.setType("*/*");
        try {
          startActivityForResult(pick, REQ_PICK_FILE);
          return true;
        } catch (ActivityNotFoundException e) {
          pendingPick = null;
          Toast.makeText(MainActivity.this, "ファイルを選ぶアプリが見つかりません", Toast.LENGTH_LONG).show();
          return false;
        }
      }
    });

    web.addJavascriptInterface(new NativeBridge(this), "AndroidApp");

    // 復帰できなければ最初から読み込む (真っ白なまま残らないように)
    if (saved == null || web.restoreState(saved) == null) web.loadUrl(START_URL);
  }

  /** アプリの外へ出す URL か判定し、外なら端末のブラウザやメールに渡す。 */
  private boolean openOutside(Uri u) {
    if (u == null) return false;
    String scheme = u.getScheme();
    if (("https".equals(scheme) || "http".equals(scheme)) && START_URL.startsWith(scheme + "://" + u.getHost())) {
      return false; // assets 内の移動はそのまま WebView で
    }
    try {
      Intent i = new Intent(Intent.ACTION_VIEW, u);
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      startActivity(i);
    } catch (ActivityNotFoundException e) {
      Toast.makeText(this, "開けるアプリが見つかりません", Toast.LENGTH_SHORT).show();
    }
    return true;
  }

  @Override
  protected void onActivityResult(int req, int res, Intent data) {
    if (req != REQ_PICK_FILE) {
      super.onActivityResult(req, res, data);
      return;
    }
    ValueCallback<Uri[]> cb = pendingPick;
    pendingPick = null;
    if (cb == null) return;
    Uri[] out = null;
    if (res == RESULT_OK && data != null && data.getData() != null) out = new Uri[]{data.getData()};
    cb.onReceiveValue(out);
  }

  @Override
  protected void onSaveInstanceState(Bundle out) {
    super.onSaveInstanceState(out);
    web.saveState(out);
  }

  @Override
  public void onBackPressed() {
    // 開いているシートやメニューがあれば、まずそれを閉じる。
    web.evaluateJavascript(
        "(function(){try{return !!(window.OrderViewNative && OrderViewNative.back());}catch(e){return false;}})()",
        value -> {
          if ("true".equals(value)) return;
          if (web.canGoBack()) web.goBack();
          else finish();
        });
  }

  @Override
  protected void onDestroy() {
    if (web != null) {
      web.removeJavascriptInterface("AndroidApp");
      web.destroy();
      web = null;
    }
    super.onDestroy();
  }
}

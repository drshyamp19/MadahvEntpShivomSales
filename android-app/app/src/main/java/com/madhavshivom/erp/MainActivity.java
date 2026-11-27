package com.madhavshivom.erp;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

public class MainActivity extends AppCompatActivity {

    private static final String ERP_URL = "https://madhav-enterprises.mserp.workers.dev";
    private static final String ERP_HOST = "madhav-enterprises.mserp.workers.dev";
    private static final String ERP_HOST_ALT = "shivom-sales.mserp.workers.dev";
    private static final int FILE_CHOOSER_REQUEST_CODE = 1001;
    private static final int CAMERA_PERMISSION_REQUEST_CODE = 1002;
    private static final int DIRECT_CAMERA_REQUEST_CODE = 1003;

    private WebView webView;
    private ProgressBar progressBar;
    private LinearLayout offlineView;
    private long lastBackPressTime = 0L;
    private ValueCallback<Uri[]> uploadMessage;
    private Uri cameraImageUri;
    private String directCameraTarget = "col";
    private PermissionRequest pendingPermissionRequest;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.erpWebView);
        progressBar = findViewById(R.id.topProgressBar);
        offlineView = findViewById(R.id.offlineView);
        Button btnRetry = findViewById(R.id.btnRetry);

        btnRetry.setOnClickListener(v -> {
            offlineView.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
            webView.loadUrl(ERP_URL);
        });

        // Request runtime Camera permission if not granted
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST_CODE);
            }
        }

        setupWebView();
        setupBackNavigation();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(ERP_URL);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setMediaPlaybackRequiresUserGesture(false);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidApp");

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (newProgress < 100) {
                    progressBar.setVisibility(View.VISIBLE);
                    progressBar.setProgress(newProgress);
                } else {
                    progressBar.setVisibility(View.GONE);
                }
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                            pendingPermissionRequest = request;
                            requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST_CODE);
                            return;
                        }
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                        request.grant(request.getResources());
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (uploadMessage != null) {
                    uploadMessage.onReceiveValue(null);
                    uploadMessage = null;
                }
                uploadMessage = filePathCallback;

                // 1. Camera Intent with pre-allocated safe content:// Uri
                Intent takePictureIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                try {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Images.Media.TITLE, "Receipt_" + System.currentTimeMillis() + ".jpg");
                    values.put(MediaStore.Images.Media.DESCRIPTION, "Madhav ERP Payment Proof");
                    cameraImageUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                    if (cameraImageUri != null) {
                        takePictureIntent.putExtra(MediaStore.EXTRA_OUTPUT, cameraImageUri);
                    }
                } catch (Exception e) {
                    cameraImageUri = null;
                }

                // 2. Gallery / Document Intent
                Intent contentSelectionIntent = new Intent(Intent.ACTION_GET_CONTENT);
                contentSelectionIntent.addCategory(Intent.CATEGORY_OPENABLE);
                contentSelectionIntent.setType("image/*");

                Intent[] intentArray;
                if (cameraImageUri != null) {
                    intentArray = new Intent[]{takePictureIntent};
                } else {
                    intentArray = new Intent[0];
                }

                Intent chooserIntent = new Intent(Intent.ACTION_CHOOSER);
                chooserIntent.putExtra(Intent.EXTRA_INTENT, contentSelectionIntent);
                chooserIntent.putExtra(Intent.EXTRA_TITLE, "Select Receipt Photo or Open Camera");
                chooserIntent.putExtra(Intent.EXTRA_INITIAL_INTENTS, intentArray);

                try {
                    startActivityForResult(chooserIntent, FILE_CHOOSER_REQUEST_CODE);
                } catch (ActivityNotFoundException e) {
                    uploadMessage = null;
                    Toast.makeText(MainActivity.this, "Cannot open file/camera chooser", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                progressBar.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
                CookieManager.getInstance().flush();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) return false;

                String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase() : "";
                String host = uri.getHost() != null ? uri.getHost().toLowerCase() : "";

                // Handle WhatsApp, Phone Dialer, SMS, Email natively
                if ("whatsapp".equals(scheme)
                        || "tel".equals(scheme)
                        || "mailto".equals(scheme)
                        || "sms".equals(scheme)
                        || host.equals("wa.me")
                        || host.endsWith(".whatsapp.com")
                        || host.equals("whatsapp.com")) {
                    openExternalUri(uri);
                    return true;
                }

                // Keep our ERP portal inside the WebView (both domains and subdomains supported)
                if (("https".equals(scheme) || "http".equals(scheme))
                        && (host.endsWith("mserp.workers.dev") || host.endsWith(ERP_HOST) || host.endsWith(ERP_HOST_ALT) || host.endsWith("madhavshivom.workers.dev"))) {
                    return false;
                }

                // Open any other external links in default browser
                if ("https".equals(scheme) || "http".equals(scheme)) {
                    openExternalUri(uri);
                    return true;
                }

                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    webView.setVisibility(View.GONE);
                    offlineView.setVisibility(View.VISIBLE);
                }
            }
        });
    }

    private void openExternalUri(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app found to handle this link.", Toast.LENGTH_SHORT).show();
        }
    }

    private void setupBackNavigation() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    long now = System.currentTimeMillis();
                    if (now - lastBackPressTime < 2000L) {
                        finish();
                    } else {
                        lastBackPressTime = now;
                        Toast.makeText(MainActivity.this, "Press back again to exit Madhav ERP", Toast.LENGTH_SHORT).show();
                    }
                }
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (uploadMessage != null) {
                Uri[] results = null;
                if (resultCode == RESULT_OK) {
                    if (data == null || data.getData() == null) {
                        // Camera capture used EXTRA_OUTPUT
                        if (cameraImageUri != null) {
                            results = new Uri[]{cameraImageUri};
                        }
                    } else {
                        if (data.getData() != null) {
                            results = new Uri[]{data.getData()};
                        } else if (data.getClipData() != null) {
                            int count = data.getClipData().getItemCount();
                            results = new Uri[count];
                            for (int i = 0; i < count; i++) {
                                results[i] = data.getClipData().getItemAt(i).getUri();
                            }
                        }
                    }
                }
                uploadMessage.onReceiveValue(results);
                uploadMessage = null;
            }
        } else if (requestCode == DIRECT_CAMERA_REQUEST_CODE) {
            if (resultCode == RESULT_OK && cameraImageUri != null) {
                deliverCapturedPhotoToWebView(cameraImageUri, directCameraTarget);
            }
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CAMERA_PERMISSION_REQUEST_CODE) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                if (pendingPermissionRequest != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    pendingPermissionRequest.grant(pendingPermissionRequest.getResources());
                    pendingPermissionRequest = null;
                }
                if (webView != null) {
                    webView.evaluateJavascript("if (typeof initLiveCameraStream === 'function') { initLiveCameraStream(); }", null);
                }
            } else {
                if (pendingPermissionRequest != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    pendingPermissionRequest.deny();
                    pendingPermissionRequest = null;
                }
                Toast.makeText(this, "Camera permission is required for in-app camera viewfinder.", Toast.LENGTH_LONG).show();
            }
        }
    }

    private void deliverCapturedPhotoToWebView(Uri imageUri, String target) {
        new Thread(() -> {
            try {
                InputStream inputStream = getContentResolver().openInputStream(imageUri);
                if (inputStream != null) {
                    Bitmap bitmap = BitmapFactory.decodeStream(inputStream);
                    inputStream.close();
                    if (bitmap != null) {
                        int maxDim = 1280;
                        int width = bitmap.getWidth();
                        int height = bitmap.getHeight();
                        if (width > maxDim || height > maxDim) {
                            float ratio = Math.min((float) maxDim / width, (float) maxDim / height);
                            width = Math.round(width * ratio);
                            height = Math.round(height * ratio);
                            bitmap = Bitmap.createScaledBitmap(bitmap, width, height, true);
                        }
                        ByteArrayOutputStream baos = new ByteArrayOutputStream();
                        bitmap.compress(Bitmap.CompressFormat.JPEG, 75, baos);
                        byte[] imageBytes = baos.toByteArray();
                        String base64Image = "data:image/jpeg;base64," + Base64.encodeToString(imageBytes, Base64.NO_WRAP);

                        runOnUiThread(() -> {
                            String js = String.format("if (typeof window.onAndroidCameraPhotoCaptured === 'function') { window.onAndroidCameraPhotoCaptured('%s', '%s'); }",
                                    base64Image, target);
                            webView.evaluateJavascript(js, null);
                        });
                    }
                }
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Failed to process photo: " + e.getMessage(), Toast.LENGTH_SHORT).show());
            }
        }).start();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    private class AndroidBridge {
        @JavascriptInterface
        public void takeCameraPhoto(final String target) {
            runOnUiThread(() -> {
                directCameraTarget = (target != null && !target.trim().isEmpty()) ? target.trim() : "col";

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                        requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST_CODE);
                        Toast.makeText(MainActivity.this, "Please allow Camera permission", Toast.LENGTH_SHORT).show();
                        return;
                    }
                }

                Intent takePictureIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                try {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Images.Media.TITLE, "DirectReceipt_" + System.currentTimeMillis() + ".jpg");
                    cameraImageUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                    if (cameraImageUri != null) {
                        takePictureIntent.putExtra(MediaStore.EXTRA_OUTPUT, cameraImageUri);
                    }
                    startActivityForResult(takePictureIntent, DIRECT_CAMERA_REQUEST_CODE);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Could not launch camera: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void clearCacheAndReload() {
            runOnUiThread(() -> {
                if (webView != null) {
                    webView.clearCache(true);
                    webView.reload();
                    Toast.makeText(MainActivity.this, "App refreshed with latest updates", Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void printPage(final String title) {
            runOnUiThread(() -> {
                try {
                    PrintManager printManager = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                    if (printManager == null) {
                        Toast.makeText(MainActivity.this, "Print service unavailable.", Toast.LENGTH_SHORT).show();
                        return;
                    }
                    String jobName = (title != null && !title.trim().isEmpty()) ? title.trim() : "Madhav_ERP_Document";
                    PrintDocumentAdapter printAdapter = webView.createPrintDocumentAdapter(jobName);
                    printManager.print(jobName, printAdapter, new PrintAttributes.Builder().build());
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Print failed: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void saveExcelBase64(final String filename, final String base64Data) {
            runOnUiThread(() -> {
                try {
                    String safeName = (filename != null && !filename.trim().isEmpty())
                            ? filename.replaceAll("[^a-zA-Z0-9._-]", "_")
                            : "Madhav_ERP_Backup.xlsx";
                    byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        ContentValues values = new ContentValues();
                        values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                        values.put(MediaStore.Downloads.MIME_TYPE,
                                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
                        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);

                        ContentResolver resolver = getContentResolver();
                        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                        if (uri != null) {
                            try (OutputStream out = resolver.openOutputStream(uri)) {
                                if (out != null) {
                                    out.write(bytes);
                                }
                            }
                            Toast.makeText(MainActivity.this, "Saved to Downloads: " + safeName, Toast.LENGTH_LONG).show();
                        }
                    } else {
                        File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                        if (!downloadsDir.exists()) {
                            downloadsDir.mkdirs();
                        }
                        File outFile = new File(downloadsDir, safeName);
                        try (FileOutputStream fos = new FileOutputStream(outFile)) {
                            fos.write(bytes);
                        }
                        Toast.makeText(MainActivity.this, "Saved to Downloads: " + safeName, Toast.LENGTH_LONG).show();
                    }
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Failed to save Excel: " + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            });
        }
    }
}

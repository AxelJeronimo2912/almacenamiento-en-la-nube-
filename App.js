import "react-native-url-polyfill/auto";
import React, { useEffect, useState, useCallback } from "react";
import {
  View, Text, TextInput, TouchableOpacity, Image, ActivityIndicator,
  ScrollView, StyleSheet, SafeAreaView, StatusBar, Platform,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { decode } from "base64-arraybuffer";

// ---------- Configuración ----------
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const BUCKET = "incidencias";
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
});

const friendly = (e) => {
  const m = e?.message ?? String(e);
  if (/network|fetch|failed to|timeout|offline/i.test(m))
    return "Sin conexión con el servicio de almacenamiento. Revisa tu internet e inténtalo de nuevo.";
  return m;
};

// ---------- Validación local del archivo ----------
function validar(asset) {
  const mime = asset.mimeType ?? guessMime(asset.uri);
  if (!ALLOWED[mime]) throw new Error(`Formato no permitido (${mime ?? "desconocido"}). Usa JPG, PNG o WebP.`);
  if (!asset.base64) throw new Error("No se pudo leer la imagen seleccionada.");
  const bytes = asset.fileSize ?? Math.floor((asset.base64.length * 3) / 4);
  if (bytes > MAX_BYTES) throw new Error(`La imagen pesa ${(bytes / 1048576).toFixed(1)} MB y el máximo es 5 MB.`);
  return { mime, ext: ALLOWED[mime], base64: asset.base64, bytes };
}
function guessMime(uri = "") {
  const e = uri.split("?")[0].split(".").pop().toLowerCase();
  return { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[e];
}

// ---------- Pantalla ----------
export default function App() {
  const [user, setUser] = useState(null);
  const [titulo, setTitulo] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [imagen, setImagen] = useState(null);
  const [estado, setEstado] = useState({ tipo: "idle", msg: "" });
  const [incidencias, setIncidencias] = useState([]);
  const [cargandoLista, setCargandoLista] = useState(false);
  const [prueba, setPrueba] = useState("");
  const [debugError, setDebugError] = useState(""); // Para ver si falla la URL

  // Consulta incidencias y genera URLs firmadas
  const cargarIncidencias = useCallback(async () => {
    setCargandoLista(true);
    setDebugError("");
    try {
      const { data, error } = await supabase.from("incidencias").select("*").order("creado_en", { ascending: false });
      if (error) throw error;

      const paths = data.filter((i) => i.imagen_path).map((i) => i.imagen_path);
      let urls = {};

      if (paths.length) {
        // Pedimos los enlaces firmados
        const { data: signed, error: e2 } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600);

        if (e2) {
          console.error("Error al firmar URLs:", e2);
          setDebugError("Error de permisos de Storage: " + e2.message);
          throw e2;
        }

        // Asignamos las URLs. A veces Supabase devuelve 'signedUrl' o 'signedURL' dependiendo de la versión.
        signed.forEach((s) => {
          const finalUrl = s.signedUrl || s.signedURL; // Compatibilidad
          if (finalUrl) urls[s.path] = finalUrl;
        });
      }

      setIncidencias(data.map((i) => ({ ...i, url: urls[i.imagen_path] })));
    } catch (e) {
      setEstado({ tipo: "error", msg: friendly(e) });
    } finally {
      setCargandoLista(false);
    }
  }, []);

  // Al abrir la app
  useEffect(() => {
    (async () => {
      try {
        let { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          const { data, error } = await supabase.auth.signInAnonymously();
          if (error) throw error;
          session = data.session;
        }
        setUser(session.user);
        await cargarIncidencias();
      } catch (e) {
        setEstado({ tipo: "error", msg: friendly(e) });
      }
    })();
  }, [cargarIncidencias]);

  // Galería o cámara
  const elegir = async (fuente) => {
    try {
      const permiso = fuente === "camara"
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permiso.granted) return setEstado({ tipo: "error", msg: "Permiso denegado para acceder a " + fuente });

      const opts = { mediaTypes: ["images"], quality: 0.6, base64: true };
      const r = fuente === "camara" ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      if (!r.canceled) { setImagen(r.assets[0]); setEstado({ tipo: "idle", msg: "" }); }
    } catch (e) {
      setEstado({ tipo: "error", msg: friendly(e) });
    }
  };

  // Subir imagen + guardar referencia
  const guardar = async () => {
    if (!titulo.trim()) return setEstado({ tipo: "error", msg: "El título es obligatorio." });
    if (!user) return setEstado({ tipo: "error", msg: "Sesión no iniciada." });
    let subido = null;
    try {
      setEstado({ tipo: "loading", msg: "Validando archivo..." });
      const fila = { titulo: titulo.trim(), descripcion: descripcion.trim() || null };

      if (imagen) {
        const { mime, ext, base64, bytes } = validar(imagen);
        const path = `${user.id}/${Date.now()}.${ext}`;
        setEstado({ tipo: "loading", msg: "Subiendo imagen..." });

        const { error } = await supabase.storage.from(BUCKET).upload(path, decode(base64), { contentType: mime, upsert: false });
        if (error) throw error;

        subido = path;
        Object.assign(fila, { imagen_path: path, imagen_mime: mime, imagen_bytes: bytes });
      }

      setEstado({ tipo: "loading", msg: "Guardando registro..." });
      const { error } = await supabase.from("incidencias").insert(fila);
      if (error) throw error;

      setEstado({ tipo: "ok", msg: "Incidencia registrada correctamente." });
      setTitulo(""); setDescripcion(""); setImagen(null);
      await cargarIncidencias(); // Recargar para que aparezca con foto
    } catch (e) {
      if (subido) supabase.storage.from(BUCKET).remove([subido]).catch(() => { });
      setEstado({ tipo: "error", msg: friendly(e) });
    }
  };

  // ---------- Pruebas de seguridad ----------
  const probarFormato = async () => {
    setPrueba("Subiendo un archivo .txt de prueba...");
    const { error } = await supabase.storage.from(BUCKET).upload(`${user.id}/prueba_${Date.now()}.txt`, decode("aG9sYQ=="), { contentType: "text/plain" });
    setPrueba(error ? `El servidor rechazó el archivo: ${friendly(error)}` : "Alerta: El archivo fue aceptado (revisa la configuración).");
  };

  const probarSinAutorizacion = async () => {
    const inc = incidencias.find((i) => i.imagen_path);
    if (!inc) return setPrueba("Primero registra una incidencia con fotografía.");
    const headers = { apikey: SUPABASE_KEY };
    const urls = [
      `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${inc.imagen_path}`,
      `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${inc.imagen_path}`,
    ];
    const out = [];
    for (const u of urls) {
      try { const r = await fetch(u, { headers }); out.push(`HTTP ${r.status} → ${u.includes("/public/") ? "URL pública" : "URL privada sin sesión"}`); }
      catch (e) { out.push(friendly(e)); }
    }
    setPrueba("Acceso sin autorización:\n" + out.join("\n") + "\n(Esperado: 400/403/404)");
  };

  const ocupado = estado.tipo === "loading";

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">

        <View style={s.header}>
          <Text style={s.title}>Reportar Incidencia</Text>
          <Text style={s.subtitle}>Complete el formulario para registrar un nuevo evento.</Text>
        </View>

        {/* Formulario Principal */}
        <View style={s.card}>
          <Text style={s.inputLabel}>TÍTULO DEL EVENTO</Text>
          <TextInput
            style={s.input}
            placeholder="Ej. Fuga de agua en baño de hombres"
            placeholderTextColor="#94a3b8"
            value={titulo}
            onChangeText={setTitulo}
          />

          <Text style={s.inputLabel}>DESCRIPCIÓN (OPCIONAL)</Text>
          <TextInput
            style={[s.input, { height: 100, textAlignVertical: 'top' }]}
            placeholder="Proporcione detalles adicionales..."
            placeholderTextColor="#94a3b8"
            multiline
            value={descripcion}
            onChangeText={setDescripcion}
          />

          <Text style={s.inputLabel}>EVIDENCIA FOTOGRÁFICA</Text>
          <View style={s.row}>
            <TouchableOpacity style={s.btnSecondary} onPress={() => elegir("galeria")}>
              <Text style={s.btnSecondaryText}>Seleccionar de Galería</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.btnSecondary} onPress={() => elegir("camara")}>
              <Text style={s.btnSecondaryText}>Tomar Fotografía</Text>
            </TouchableOpacity>
          </View>

          {imagen && (
            <View style={s.previewContainer}>
              <Text style={s.previewLabel}>Vista previa</Text>
              <Image source={{ uri: imagen.uri }} style={s.preview} />
            </View>
          )}

          <TouchableOpacity style={[s.btn, ocupado && s.btnDisabled]} onPress={guardar} disabled={ocupado}>
            <Text style={s.btnText}>{ocupado ? "PROCESANDO..." : "ENVIAR INCIDENCIA"}</Text>
          </TouchableOpacity>

          {ocupado && (
            <View style={s.center}>
              <ActivityIndicator color="#1e293b" style={{ marginTop: 12 }} />
              <Text style={s.smallText}>{estado.msg}</Text>
            </View>
          )}
          {estado.tipo === "ok" && <Text style={s.msgOk}>{estado.msg}</Text>}
          {estado.tipo === "error" && <Text style={s.msgError}>{estado.msg}</Text>}
        </View>

        {/* Historial */}
        <View style={s.sectionHeader}>
          <Text style={s.sectionTitle}>Registro de Incidencias</Text>
          <TouchableOpacity onPress={cargarIncidencias}>
            <Text style={s.linkText}>Actualizar lista</Text>
          </TouchableOpacity>
        </View>

        {/* Mensaje de error de depuración */}
        {!!debugError && (
          <View style={{ backgroundColor: '#fee2e2', padding: 10, borderRadius: 8, marginBottom: 10 }}>
            <Text style={{ color: '#b91c1c', fontSize: 12 }}>{debugError}</Text>
          </View>
        )}

        {cargandoLista && <ActivityIndicator color="#1e293b" style={{ marginVertical: 20 }} />}

        {!cargandoLista && incidencias.length === 0 && (
          <View style={s.emptyState}>
            <Text style={s.emptyText}>No hay incidencias registradas actualmente.</Text>
          </View>
        )}

        {incidencias.map((i) => (
          <View key={i.id} style={s.cardHistory}>
            <View style={s.cardHistoryHeader}>
              <Text style={s.cardHistoryTitle}>{i.titulo}</Text>
              <Text style={s.cardHistoryDate}>{new Date(i.creado_en).toLocaleDateString("es-MX")}</Text>
            </View>
            {!!i.descripcion && <Text style={s.cardHistoryDesc}>{i.descripcion}</Text>}

            {/* AQUÍ ESTÁ LA MAGIA: Si hay url, la muestra. Si no, muestra un texto */}
            {i.url ? (
              <Image
                source={{ uri: i.url }}
                style={s.previewHistory}
                onError={(e) => console.log("Error cargando imagen:", e.nativeEvent.error)}
              />
            ) : i.imagen_path ? (
              <Text style={s.smallText}>Cargando imagen o enlace no disponible...</Text>
            ) : null}

            <View style={s.cardHistoryFooter}>
              <Text style={s.smallText}>ID Archivo: {i.imagen_path ? i.imagen_path.split('/').pop() : "N/A"}</Text>
            </View>
          </View>
        ))}

        {/* Pruebas de Seguridad */}
        <View style={s.cardSecurity}>
          <View style={s.securityHeader}>
            <View style={s.securityIndicator} />
            <Text style={s.securityTitle}>Auditoría de Seguridad</Text>
          </View>
          <Text style={s.securityDesc}>Verifique que las políticas de acceso funcionen correctamente.</Text>

          <TouchableOpacity style={s.btnSecurity} onPress={probarFormato}>
            <Text style={s.btnSecurityText}>Probar carga de .txt</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btnSecurity, { marginTop: 8 }]} onPress={probarSinAutorizacion}>
            <Text style={s.btnSecurityText}>Probar acceso sin autorización</Text>
          </TouchableOpacity>

          {!!prueba && (
            <View style={s.securityLogContainer}>
              <Text style={s.securityLog}>{prueba}</Text>
            </View>
          )}
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f8fafc" },
  container: { padding: 16, paddingTop: Platform.OS === 'android' ? 40 : 20, paddingBottom: 60 },
  header: { marginBottom: 20 },
  title: { fontSize: 24, fontWeight: "800", color: "#0f172a", letterSpacing: -0.5 },
  subtitle: { fontSize: 14, color: "#64748b", marginTop: 4 },
  card: { backgroundColor: "#ffffff", borderRadius: 12, padding: 20, borderWidth: 1, borderColor: "#e2e8f0", marginBottom: 24 },
  inputLabel: { fontSize: 11, fontWeight: "700", color: "#475569", marginBottom: 6, letterSpacing: 0.5 },
  input: { backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 15, color: "#1e293b" },
  row: { flexDirection: "row", gap: 12, marginBottom: 16 },
  btn: { backgroundColor: "#1e293b", padding: 16, borderRadius: 8, alignItems: "center", marginTop: 8 },
  btnDisabled: { backgroundColor: "#94a3b8" },
  btnText: { color: "#ffffff", fontWeight: "700", fontSize: 14, letterSpacing: 0.5 },
  btnSecondary: { flex: 1, backgroundColor: "#f1f5f9", borderWidth: 1, borderColor: "#e2e8f0", padding: 14, borderRadius: 8, alignItems: "center" },
  btnSecondaryText: { color: "#334155", fontWeight: "600", fontSize: 13 },
  previewContainer: { marginBottom: 16 },
  previewLabel: { fontSize: 12, color: "#64748b", marginBottom: 8 },
  preview: { width: "100%", height: 220, borderRadius: 8, backgroundColor: "#e2e8f0" },
  center: { alignItems: "center", marginTop: 10 },
  msgOk: { color: "#059669", marginTop: 12, fontWeight: "600", fontSize: 14, textAlign: "center" },
  msgError: { color: "#dc2626", marginTop: 12, fontWeight: "600", fontSize: 14, textAlign: "center" },
  smallText: { fontSize: 12, color: "#64748b", marginTop: 6 },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  sectionTitle: { fontSize: 18, fontWeight: "700", color: "#0f172a" },
  linkText: { color: "#2563eb", fontWeight: "600", fontSize: 14 },
  emptyState: { padding: 24, alignItems: "center", backgroundColor: "#ffffff", borderRadius: 12, borderWidth: 1, borderColor: "#e2e8f0", borderStyle: "dashed" },
  emptyText: { color: "#94a3b8", fontSize: 14 },
  cardHistory: { backgroundColor: "#ffffff", borderRadius: 12, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: "#e2e8f0" },
  cardHistoryHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 },
  cardHistoryTitle: { fontSize: 16, fontWeight: "700", color: "#0f172a", flex: 1, marginRight: 10 },
  cardHistoryDate: { fontSize: 12, color: "#64748b", fontWeight: "500" },
  cardHistoryDesc: { fontSize: 14, color: "#334155", marginBottom: 12, lineHeight: 20 },
  previewHistory: { width: "100%", height: 180, borderRadius: 8, backgroundColor: "#f1f5f9", marginBottom: 12 },
  cardHistoryFooter: { borderTopWidth: 1, borderTopColor: "#f1f5f9", paddingTop: 10, marginTop: 4 },
  cardSecurity: { backgroundColor: "#fffbeb", borderRadius: 12, padding: 16, borderWidth: 1, borderColor: "#fde68a", marginTop: 12 },
  securityHeader: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
  securityIndicator: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#d97706", marginRight: 8 },
  securityTitle: { fontSize: 16, fontWeight: "700", color: "#92400e" },
  securityDesc: { fontSize: 13, color: "#b45309", marginBottom: 16, lineHeight: 18 },
  btnSecurity: { backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#fcd34d", padding: 12, borderRadius: 8, alignItems: "center" },
  btnSecurityText: { color: "#92400e", fontWeight: "600", fontSize: 13 },
  securityLogContainer: { marginTop: 16, backgroundColor: "#ffffff", padding: 12, borderRadius: 8, borderWidth: 1, borderColor: "#fde68a" },
  securityLog: { fontSize: 13, color: "#78350f", fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
});
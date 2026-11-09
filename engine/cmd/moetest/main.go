package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/MoeForge/moejs"
	"github.com/MoeForge/moejs/engine"
	"github.com/MoeForge/moejs/eventloop"
	"github.com/MoeForge/moejs/node"
)

var (
	homeDir = filepath.Join(os.TempDir(), "moetest-home")
	tmpDir  = os.TempDir()
)

var (
	shamu    sync.Mutex
	shaid    int
	states   = map[string]hash.Hash{}
	modmu    sync.Mutex
	modcache = map[string]*moejs.Module{}
	procMu   sync.Mutex
	procSeq  int
	procReg  = map[string]*exec.Cmd{}
	loopPtr  *eventloop.Loop
)

func timeFromValue(v moejs.Value) (time.Time, error) {
	sec, err := strconv.ParseFloat(v.String(), 64)
	if err != nil {
		return time.Time{}, fmt.Errorf("goUtimes: unsupported time value %q", v.String())
	}
	return time.Unix(int64(sec), 0), nil
}

func postEmit(id string, emit moejs.Value, event, payload string) {
	l := loopPtr
	if l == nil {
		return
	}
	if os.Getenv("PROBE_DEBUG") != "" {
		fmt.Fprintf(os.Stderr, "[emit] %s %s len=%d\n", id, event, len(payload))
	}
	eventloop.Post(l, func(rt *moejs.Runtime) error {
		_, err := rt.CallFunction(emit, engine.Undefined(), moejs.String(id), moejs.String(event), moejs.String(payload))
		if err != nil && os.Getenv("PROBE_DEBUG") != "" {
			fmt.Fprintf(os.Stderr, "[emit-err] %s %s: %v\n", id, event, err)
		}
		return err
	})
}

func execPath() string {
	p, err := os.Executable()
	if err != nil {
		return "/tmp/moejsprobe/probe"
	}
	return p
}

func ignoreSignal(name string) {
	switch name {
	case "SIGTERM":
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, syscall.SIGTERM)
		go func() {
			for range ch {
			}
		}()
	case "SIGINT":
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, syscall.SIGINT)
		go func() {
			for range ch {
			}
		}()
	}
}

var lastSpawnID string

func goSpawn(r *moejs.Realm, this moejs.Value, args []moejs.Value) (moejs.Value, error) {
	if len(args) < 5 {
		return engine.Undefined(), fmt.Errorf("goSpawn: need cmd, args, cwd, env, emit")
	}
	cmdName := args[0].String()
	var argList []string
	if err := json.Unmarshal([]byte(args[1].String()), &argList); err != nil {
		return engine.Undefined(), err
	}
	cwd := args[2].String()
	var envMap map[string]string
	if err := json.Unmarshal([]byte(args[3].String()), &envMap); err != nil {
		return engine.Undefined(), err
	}
	emit := args[4]
	envList := make([]string, 0, len(envMap))
	for k, v := range envMap {
		envList = append(envList, k+"="+v)
	}
	procMu.Lock()
	procSeq++
	id := fmt.Sprintf("p%d", procSeq)
	procMu.Unlock()
	lastSpawnID = id
	closeP, settle := loopPtr.NewPromise()
	cmd := exec.Command(cmdName, argList...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	cmd.Env = envList
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return engine.Undefined(), err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return engine.Undefined(), err
	}
	startErr := cmd.Start()
	if os.Getenv("PROBE_DEBUG") != "" {
		fmt.Fprintf(os.Stderr, "[spawn] id=%s cmd=%s startErr=%v\n", id, cmdName, startErr)
	}
	if err := startErr; err != nil {
		spawnErr := err
		settle(func(rt *moejs.Runtime) (moejs.Value, error) {
			if _, err := rt.CallFunction(emit, engine.Undefined(), moejs.String(id), moejs.String("error"), moejs.String(spawnErr.Error())); err != nil {
				return engine.Undefined(), err
			}
			_, err := rt.CallFunction(emit, engine.Undefined(), moejs.String(id), moejs.String("close"), moejs.String("1"))
			return engine.Undefined(), err
		})
		return closeP, nil
	}
	procMu.Lock()
	procReg[id] = cmd
	procMu.Unlock()
	pump := func(rc io.ReadCloser, event string) {
		buf := make([]byte, 65536)
		for {
			n, rerr := rc.Read(buf)
			if n > 0 {
				postEmit(id, emit, event, base64.StdEncoding.EncodeToString(buf[:n]))
			}
			if rerr != nil {
				return
			}
		}
	}
	go pump(stdout, "stdout:data")
	go pump(stderr, "stderr:data")
	go func() {
		werr := cmd.Wait()
		code := "0"
		if werr != nil {
			if ee, ok := werr.(*exec.ExitError); ok {
				if ee.ExitCode() >= 0 {
					code = strconv.Itoa(ee.ExitCode())
				} else {
					code = "sig:SIGTERM"
					if ws, ok2 := ee.Sys().(syscall.WaitStatus); ok2 && ws.Signaled() {
						code = "sig:" + ws.Signal().String()
					}
				}
			} else {
				code = "1"
			}
		}
		procMu.Lock()
		delete(procReg, id)
		procMu.Unlock()
		if os.Getenv("PROBE_DEBUG") != "" {
			fmt.Fprintf(os.Stderr, "[wait] id=%s done code=%s\n", id, code)
		}
		settle(func(rt *moejs.Runtime) (moejs.Value, error) {
			if _, err := rt.CallFunction(emit, engine.Undefined(), moejs.String(id), moejs.String("close"), moejs.String(code)); err != nil {
				return engine.Undefined(), err
			}
			return engine.Undefined(), nil
		})
	}()
	return closeP, nil
}

func goLastSpawnId(r *moejs.Realm, this moejs.Value, args []moejs.Value) (moejs.Value, error) {
	return moejs.String(lastSpawnID), nil
}

func goKill(r *moejs.Realm, this moejs.Value, args []moejs.Value) (moejs.Value, error) {
	if len(args) < 2 {
		return engine.Undefined(), fmt.Errorf("goKill: need id and signal")
	}
	id := args[0].String()
	sigName := args[1].String()
	procMu.Lock()
	cmd := procReg[id]
	procMu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return moejs.Bool(false), nil
	}
	sig := syscall.SIGTERM
	switch sigName {
	case "SIGKILL":
		sig = syscall.SIGKILL
	case "SIGINT":
		sig = syscall.SIGINT
	case "SIGHUP":
		sig = syscall.SIGHUP
	}
	if err := cmd.Process.Signal(sig); err != nil {
		return moejs.Bool(false), nil
	}
	return moejs.Bool(true), nil
}

func goSpawnSync(r *moejs.Realm, this moejs.Value, args []moejs.Value) (moejs.Value, error) {
	if len(args) < 4 {
		return engine.Undefined(), fmt.Errorf("goSpawnSync: need cmd, args, cwd, env")
	}
	cmdName := args[0].String()
	var argList []string
	if err := json.Unmarshal([]byte(args[1].String()), &argList); err != nil {
		return engine.Undefined(), err
	}
	cwd := args[2].String()
	var envMap map[string]string
	if err := json.Unmarshal([]byte(args[3].String()), &envMap); err != nil {
		return engine.Undefined(), err
	}
	envList := make([]string, 0, len(envMap))
	for k, v := range envMap {
		envList = append(envList, k+"="+v)
	}
	cmd := exec.Command(cmdName, argList...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	cmd.Env = envList
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	runErr := cmd.Run()
	result := map[string]any{
		"status": 0,
		"stdout": base64.StdEncoding.EncodeToString(outBuf.Bytes()),
		"stderr": base64.StdEncoding.EncodeToString(errBuf.Bytes()),
	}
	if runErr != nil {
		if ee, ok := runErr.(*exec.ExitError); ok {
			result["status"] = ee.ExitCode()
		} else {
			result["status"] = 1
			result["error"] = runErr.Error()
			result["errorCode"] = "SPAWN_ERROR"
		}
	}
	b, _ := json.Marshal(result)
	return moejs.String(string(b)), nil
}

func nativeLog(r *moejs.Realm, this moejs.Value, args []moejs.Value) (moejs.Value, error) {
	parts := make([]string, len(args))
	for i, a := range args {
		parts[i] = a.String()
	}
	fmt.Println(strings.Join(parts, " "))
	return engine.Undefined(), nil
}

func shaBegin(r *moejs.Realm, this moejs.Value, args []moejs.Value) (moejs.Value, error) {
	shamu.Lock()
	defer shamu.Unlock()
	shaid++
	id := fmt.Sprintf("h%d", shaid)
	states[id] = sha256.New()
	return moejs.String(id), nil
}

func shaUpdateStr(r *moejs.Realm, this moejs.Value, args []moejs.Value) (moejs.Value, error) {
	if len(args) < 2 {
		return engine.Undefined(), fmt.Errorf("shaUpdateStr: need id and string")
	}
	shamu.Lock()
	defer shamu.Unlock()
	h := states[args[0].String()]
	if h == nil {
		return engine.Undefined(), fmt.Errorf("shaUpdateStr: unknown hash id")
	}
	h.Write([]byte(args[1].String()))
	return engine.Undefined(), nil
}

func shaUpdateB64(r *moejs.Realm, this moejs.Value, args []moejs.Value) (moejs.Value, error) {
	if len(args) < 2 {
		return engine.Undefined(), fmt.Errorf("shaUpdateB64: need id and base64")
	}
	raw, err := base64.StdEncoding.DecodeString(args[1].String())
	if err != nil {
		return engine.Undefined(), err
	}
	shamu.Lock()
	defer shamu.Unlock()
	h := states[args[0].String()]
	if h == nil {
		return engine.Undefined(), fmt.Errorf("shaUpdateB64: unknown hash id")
	}
	h.Write(raw)
	return engine.Undefined(), nil
}

func shaEnd(r *moejs.Realm, this moejs.Value, args []moejs.Value) (moejs.Value, error) {
	if len(args) < 1 {
		return engine.Undefined(), fmt.Errorf("shaEnd: need id")
	}
	shamu.Lock()
	defer shamu.Unlock()
	h := states[args[0].String()]
	if h == nil {
		return engine.Undefined(), fmt.Errorf("shaEnd: unknown hash id")
	}
	sum := h.Sum(nil)
	delete(states, args[0].String())
	return moejs.String(hex.EncodeToString(sum)), nil
}

func compileOnce(name, src string, ts bool) (*moejs.Module, error) {
	modmu.Lock()
	defer modmu.Unlock()
	if m, ok := modcache[name]; ok {
		return m, nil
	}
	var m *moejs.Module
	var err error
	if ts {
		m, err = moejs.CompileTS(name, src)
	} else {
		m, err = moejs.Compile(name, src)
	}
	if err != nil {
		return nil, err
	}
	modcache[name] = m
	return m, nil
}

func resolveMod(referrer moejs.Referrer, specifier string) (*moejs.Module, error) {
	if strings.HasPrefix(specifier, "./") || strings.HasPrefix(specifier, "../") || strings.HasPrefix(specifier, "/") {
		base := "/"
		if m, ok := referrer.(*moejs.Module); ok && m.Name() != "" {
			base = filepath.Dir(m.Name())
		}
		p := specifier
		if !filepath.IsAbs(p) {
			p = filepath.Join(base, p)
		}
		if !strings.HasSuffix(p, ".ts") && !strings.HasSuffix(p, ".js") {
			p += ".ts"
		}
		src, err := os.ReadFile(p)
		if err != nil {
			return nil, fmt.Errorf("resolve %s: %w", specifier, err)
		}
		src = []byte(strings.ReplaceAll(string(src), "\"node:fs\"", "\"orch:fs\""))
		return compileOnce(p, string(src), strings.HasSuffix(p, ".ts"))
	}
	switch specifier {
	case "node:url":
		return compileOnce("node:url", urlShim, false)
	case "node:child_process":
		return compileOnce("node:child_process", childProcShim, false)
	case "node:assert/strict", "node:assert":
		return compileOnce("node:assert", assertShim, false)
	case "orch:fs":
		return compileOnce("orch:fs", fsWrapperSrc, false)
	case "node:path":
		return compileOnce("node:path", pathShim, false)
	case "node:os":
		return compileOnce("node:os", osShim, false)
	case "node:crypto":
		return compileOnce("node:crypto", cryptoShim, false)
	}
	return nil, fmt.Errorf("probe resolver: unsupported specifier %q", specifier)
}

func runEval(code string) {
	_, loop, _ := setupRuntime()
	script, err := moejs.CompileScript("eval.js", bootScriptSrc+code)
	if err != nil {
		fmt.Println("moetest: eval compile error:", err)
		os.Exit(1)
	}
	err = loop.Run(func(rt *moejs.Runtime) error {
		_, err := rt.RunScript(script)
		return err
	})
	if err != nil {
		fmt.Println("moetest: eval error:", err)
		os.Exit(1)
	}
	exitScript, err := moejs.CompileScript("exit.js", "typeof process.exitCode === 'number' ? process.exitCode : 0")
	if err != nil {
		panic(err)
	}
	var exitCode int32
	err = loop.Run(func(rt *moejs.Runtime) error {
		res, err := rt.RunScript(exitScript)
		if err != nil {
			return err
		}
		if c, ok := res.IsInt32(); ok {
			exitCode = c
		}
		return nil
	})
	if err != nil {
		panic(err)
	}
	os.Exit(int(exitCode))
}

func setupRuntime() (*moejs.Runtime, *eventloop.Loop, *moejs.Importer) {
	if err := os.MkdirAll(homeDir, 0o755); err != nil {
		panic(err)
	}
	imp := &moejs.Importer{Resolve: resolveMod, Meta: func(r *moejs.Realm, m *moejs.Module, meta *moejs.Object) error {
		return meta.SetProp(r, r.KeyFromGoString("url"), moejs.String("file://"+m.Name()))
	}}
	rt := moejs.NewRuntime(moejs.Options{Importer: node.Importer(imp), MemoryLimit: 256 << 20})
	loop, err := eventloop.New(rt, eventloop.Options{})
	if err != nil {
		panic(err)
	}
	loopPtr = loop
	if _, err := node.InstallLoop(loop, node.Options{FS: &node.FSOptions{Root: "/", Write: true}, Buffer: true}); err != nil {
		panic(err)
	}
	rt.SetGlobal("__goLog", moejs.NativeFunc(nativeLog))
	rt.SetGlobal("console", map[string]any{
		"log":   moejs.NativeFunc(nativeLog),
		"error": moejs.NativeFunc(nativeLog),
		"warn":  moejs.NativeFunc(nativeLog),
	})
	rt.SetGlobal("__goHomedir", moejs.NativeFunc(func(r *moejs.Realm, this moejs.Value, args []moejs.Value) (moejs.Value, error) {
		return moejs.String(homeDir), nil
	}))
	rt.SetGlobal("__goTmpdir", moejs.NativeFunc(func(r *moejs.Realm, this moejs.Value, args []moejs.Value) (moejs.Value, error) {
		return moejs.String(tmpDir), nil
	}))
	rt.SetGlobal("process", map[string]any{
		"pid":      os.Getpid(),
		"platform": "linux",
		"execPath": execPath(),
		"argv":     os.Args,
		"env":      map[string]string{"HOME": homeDir, "TMPDIR": tmpDir, "PATH": os.Getenv("PATH")},
		"stdout":   map[string]any{"write": moejs.NativeFunc(nativeLog)},
		"stderr":   map[string]any{"write": moejs.NativeFunc(nativeLog)},
		"on": moejs.NativeFunc(func(r *moejs.Realm, this moejs.Value, args []moejs.Value) (moejs.Value, error) {
			if len(args) >= 1 {
				ignoreSignal(args[0].String())
			}
			return engine.Undefined(), nil
		}),
		"exit": moejs.NativeFunc(func(r *moejs.Realm, this moejs.Value, args []moejs.Value) (moejs.Value, error) {
			return engine.Undefined(), nil
		}),
	})
	rt.SetGlobal("__goChmod", moejs.NativeFunc(func(r *moejs.Realm, this moejs.Value, args []moejs.Value) (moejs.Value, error) {
		if len(args) < 2 {
			return engine.Undefined(), fmt.Errorf("goChmod: need path and mode")
		}
		mode := int64(0)
		if m, ok := args[1].IsInt32(); ok {
			mode = int64(m)
		}
		if err := os.Chmod(args[0].String(), os.FileMode(mode)); err != nil {
			return engine.Undefined(), err
		}
		return engine.Undefined(), nil
	}))
	rt.SetGlobal("__goSymlink", moejs.NativeFunc(func(r *moejs.Realm, this moejs.Value, args []moejs.Value) (moejs.Value, error) {
		if len(args) < 2 {
			return engine.Undefined(), fmt.Errorf("goSymlink: need target and path")
		}
		if err := os.Symlink(args[0].String(), args[1].String()); err != nil {
			return engine.Undefined(), err
		}
		return engine.Undefined(), nil
	}))
	rt.SetGlobal("__goMkdtemp", moejs.NativeFunc(func(r *moejs.Realm, this moejs.Value, args []moejs.Value) (moejs.Value, error) {
		if len(args) < 1 {
			return engine.Undefined(), fmt.Errorf("goMkdtemp: need prefix")
		}
		prefix := args[0].String()
		dir := filepath.Dir(prefix)
		if dir == "" {
			dir = "."
		}
		tmp, err := os.MkdirTemp(dir, filepath.Base(prefix))
		if err != nil {
			return engine.Undefined(), err
		}
		return moejs.String(tmp), nil
	}))
	rt.SetGlobal("__goUtimes", moejs.NativeFunc(func(r *moejs.Realm, this moejs.Value, args []moejs.Value) (moejs.Value, error) {
		if len(args) < 3 {
			return engine.Undefined(), fmt.Errorf("goUtimes: need path, atime, mtime")
		}
		at, err := timeFromValue(args[1])
		if err != nil {
			return engine.Undefined(), err
		}
		mt, err := timeFromValue(args[2])
		if err != nil {
			return engine.Undefined(), err
		}
		if err := os.Chtimes(args[0].String(), at, mt); err != nil {
			return engine.Undefined(), err
		}
		return engine.Undefined(), nil
	}))
	rt.SetGlobal("__goSpawn", moejs.NativeFunc(goSpawn))
	rt.SetGlobal("__goLastSpawnId", moejs.NativeFunc(goLastSpawnId))
	rt.SetGlobal("__goKill", moejs.NativeFunc(goKill))
	rt.SetGlobal("__goSpawnSync", moejs.NativeFunc(goSpawnSync))
	rt.SetGlobal("__goSha256Begin", moejs.NativeFunc(shaBegin))
	rt.SetGlobal("__goSha256UpdateStr", moejs.NativeFunc(shaUpdateStr))
	rt.SetGlobal("__goSha256UpdateB64", moejs.NativeFunc(shaUpdateB64))
	rt.SetGlobal("__goSha256End", moejs.NativeFunc(shaEnd))
	return rt, loop, imp
}

func main() {
	if len(os.Args) > 2 && os.Args[1] == "-e" {
		runEval(os.Args[2])
		return
	}
	_, loop, imp := setupRuntime()

	var entry *moejs.Module
	if len(os.Args) > 1 {
		src, err := os.ReadFile(os.Args[1])
		if err != nil {
			panic(err)
		}
		transformed := strings.ReplaceAll(string(src), "\"node:fs\"", "\"orch:fs\"")
		transformed = abortShim + bootSrc + transformed
		transformed += "\nexport function __exitCode() { return typeof process.exitCode === \"number\" ? process.exitCode : 0; }\n"
		entry, err = moejs.CompileTS(os.Args[1], transformed)
		if err != nil {
			panic(err)
		}
	} else {
		fmt.Println("usage: moetest <suite.ts> | moetest -e <code>")
		os.Exit(2)
	}
	mod, err := moejs.Link(entry, node.Importer(imp).Resolve)
	if err != nil {
		panic(err)
	}
	err = loop.Run(func(rt *moejs.Runtime) error {
		lerr := rt.Load(mod)
		if errors.Is(lerr, moejs.ErrModulePending) {
			return nil
		}
		return lerr
	})
	if err != nil {
		fmt.Println("moetest: load error:", err)
		os.Exit(1)
	}
	if len(os.Args) > 1 {
		hook, err := mod.Hook("__exitCode")
		if err != nil {
			panic(err)
		}
		var exitCode int32
		err = loop.Run(func(rt *moejs.Runtime) error {
			res, err := rt.Call(hook)
			if err != nil {
				return err
			}
			if c, ok := res.IsInt32(); ok {
				exitCode = c
			}
			return nil
		})
		if err != nil {
			fmt.Println("EXITCODE READ ERROR:", err)
			os.Exit(1)
		}
		if exitCode != 0 {
			fmt.Println("moetest: suite failed with exitCode", exitCode)
			os.Exit(1)
		}
	}
	fmt.Println("moetest OK")
}

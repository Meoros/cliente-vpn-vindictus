const config = require('./config.json')
const { execSync, execFileSync, exec, execFile, spawn } = require('child_process');
const elevator = require('elevator');
const sudo = require('sudo-prompt');
const fs = require('fs');
const request = require('request');
const dns = require('dns-sync');

let actualizarConfig = function (key, valor) {
    let direccion = key.split('.');
    let iterador = config;

    if (direccion.length > 1) {
        for (let i = 0; i < direccion.length; i++) {
            iterador = iterador[direccion[i]];
            if (i === direccion.length - 2) {
                iterador[direccion[i + 1]] = valor;
            }
        }
    }
    else {
        iterador[key] = valor;
    }


    fs.writeFileSync("./config.json", JSON.stringify(config, null, "\t"));
}

let generarBloqueKey = function (publicKey) {
    let lineas = ["\n\n-----BEGIN RSA PUBLIC KEY-----"]

    for (let i = 0; i < publicKey.length; i += 64) {
        lineas.push(publicKey.substr(i, 64))
    }

    lineas.push("-----END RSA PUBLIC KEY-----\n");
    return lineas.join("\n");
}

let verificarTapAdapter = function () {
    let interfazEncontrada = false;
    let stdout;

    try {
        stdout = execSync('netsh interface show interface');
    } catch (err) {
        console.error(err);
        process.exit(1);
    }

    let lineasRetorno = stdout.toString('utf8').split('\n');

    lineasRetorno.forEach(linea => {
        if (linea.indexOf(config.nombreInterfaz) > -1) {
            interfazEncontrada = true;
        }
    });

    return interfazEncontrada;
};

let obtenerUltimoAdaptador = function () {
    let adaptador = "";
    let stdout;

    try {
        stdout = execSync('netsh interface show interface');
    } catch (err) {
        console.error(err);
        process.exit(1);
    }

    let lineasRetorno = stdout.toString('utf8').split('\n');

    lineasRetorno.forEach(linea => {
        if (linea && linea.length > 1) {
            adaptador = linea.replace(/^[^\s\t]+[\s\t]+[^\s\t]+[\s\t]+[^\s\t]+[\s\t]+/, "");
        }
    });

    return adaptador;
};

let renombrarAdaptador = function (viejoNombre, nuevoNombre) {
    let cmd = 'netsh interface set interface name="' + viejoNombre + '" newname="' + nuevoNombre + '"';

    try {
        sudo.exec(cmd, { name: "Cliente RPV" }, (error, stdout, stderr) => {
            if (error) {
                console.error(`exec error: ${error}`);
                process.exit(1);
            }
            else {
                ejecutar();
            }
        });
    } catch (err) {
        console.error("Comando: " + cmd + "\r\n Ha fallado al ejecutarse");
    }
}

let instalarAdaptador = function () {
    let stdout;
    let cwd = __dirname + "\\tinc\\" + (config.x64 ? "tap-win64\\" : "tap-win32");
    let cmd = 'cmd /c "cd ' + cwd + ' && tapinstall install OemWin2k.inf tap0901"';


    try {
        stdout = sudo.exec(cmd, { name: "Cliente RPV" }, (error, stdout, stderr) => {
            if (error) {

                console.error(`exec error: ${error}`);
                process.exit(1);
            }
            else {
                renombrarAdaptador(obtenerUltimoAdaptador(), config.nombreInterfaz);
            }
        });
    } catch (err) {
        console.error("Comando: " + cmd + "\r\n Ha fallado al ejecutarse");
    }
};

let createDir = function (dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir)
    }
}

let crearBase = function () {
    createDir("./" + config.nombreVPN);
    createDir("./" + config.nombreVPN + "/hosts");

    if (!config.cliente.id) {
        actualizarConfig("cliente.id", require('uuid/v4')().replace(/-/g, "_"));
    }

    fs.writeFileSync("./" + config.nombreVPN + "/hosts/" + config.cliente.id, "Subnet = " + config.cliente.subNet + "\r\n");
    fs.writeFileSync("./" + config.nombreVPN + "/tinc.conf", "Name = " + config.cliente.id);
    fs.appendFileSync("./" + config.nombreVPN + "/tinc.conf", "\nAddressFamily = ipv4");
    fs.appendFileSync("./" + config.nombreVPN + "/tinc.conf", "\nInterface = " + config.nombreInterfaz);
    fs.appendFileSync("./" + config.nombreVPN + "/tinc.conf", "\nConnectTo = " + config.server.id);
    fs.appendFileSync("./" + config.nombreVPN + "/tinc.conf", "\nMode = switch");

    ejecutar();
};

let crearPublicKey = function () {
    let cmd = 'echo "\\n\\n" | "' + __dirname + '\\tinc\\tincd.exe" -c ./' + config.nombreVPN + ' -K';
    try {
        execSync(cmd);
        let publicKey = fs.readFileSync("./" + config.nombreVPN + "/hosts/" + config.cliente.id).toString()
            .replace(/[0-9a-zA-Z/.: =\r\n\t]*-----BEGIN RSA PUBLIC KEY-----[\n\r]*/g, '')
            .replace(/[\n\r]+-----END RSA PUBLIC KEY-----[\n\r]+/g, '')
            .replace(/[\n\r]/g, "");

        if (publicKey.length === 360 && /^[0-9A-Za-z+/][0-9A-Za-z+/\r\n]+[0-9A-Za-z+/]$/.test(publicKey)) {
            actualizarConfig('cliente.publicKey', publicKey);
            ejecutar();
        }
        else {
            console.error("Public Key inválida:\n" + publicKey);
            process.exit(1);
        }

    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

let registrarPublicKey = function () {

    let body = {
        "id": config.cliente.id,
        "publicKey": config.cliente.publicKey
    };

    let options = {
        url: config.api + '/registrarCliente',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        json: body
    };

    request(options, function (err, res, body) {
        if (res && (res.statusCode === 200 || res.statusCode === 201)) {
            actualizarConfig('server.publicKey', body.publicKey);
            actualizarConfig('server.gateway', body.gateway);
            actualizarConfig('server.address', body.address);
            actualizarConfig('rutas', body.rutas);

            fs.writeFileSync("./" + config.nombreVPN + "/hosts/" + config.server.id, "Address = " + body.address + "\r\n");
            fs.appendFileSync("./" + config.nombreVPN + "/hosts/" + config.server.id, "Subnet = " + "13.13.1.1/32" + "\r\n");
            fs.appendFileSync("./" + config.nombreVPN + "/hosts/" + config.server.id, generarBloqueKey(body.publicKey));

            ejecutar();
        }
        else {
            console.error(body ? 'Error: ' + res.statusCode + "  " + body : 'Error: no se pudo establecer la comunicacion con el servidor');
            process.exit(1);
        }
    });
}

let obtenerIP = function (dominio) {
    let cmd = 'nslookup ' + dominio + ' | findstr /r "[0-9.]+"'

    try {
        let retorno = execSync(cmd).toString().replace(/[\t ]/g, "");
        return retorno;
    }
    catch (err) {
        console.error(err);
        process.exit(1);
    }

}
/*
let obtenerIPs = function () {
    for (let i = 0; i < config.rutas.length; i++) {
        actualizarConfig(["rutas", i.toString(), "ip"].join("."), dns.lookup(config.rutas[i].dominio))
    }
}*/

let obtenerIPs = function (ruta) {
    let ips = [];
    let retornoDns = dns.resolve(ruta.dominio, 'A');

    if(!Array.isArray(retornoDns)){
        ips.push(retornoDns);
    }
    else{
        ips = retornoDns;
    }

    return ips;
}
/*
let modificarArchivoHost = function (cambios) {
    let cmd = 'type "' + __dirname + "\\" + 'hosts" > "' + process.env.WINDIR + "\\System32\\drivers\\etc\\hosts";
    let cmdEliminar = "";
    fs.copyFileSync(process.env.WINDIR + "\\System32\\drivers\\etc\\hosts", "./host.bkp");
    cambios.lineasEliminar.forEach(linea => {
        cambios.archivo.splice(linea, 1);
    });

    cambios.dominiosAgregar.forEach(host => {
        cambios.archivo.push(host.ip + "\t" + host.dominio);
    });

    try {
        fs.writeFileSync("./hosts", cambios.archivo.join("\r\n"));
        sudo.exec(cmd, { name: "Cliente RPV" }, (error, stdout, stderr) => {
            if (error) {
                console.error(`exec error: ${error}`);
                process.exit(1);
            }
            else {
                ejecutar();
            }
        });
    }
    catch (err) {
        console.error(err);
        process.exit(1);
    }
}

let verificarArchivoHost = function () {
    let path = process.env.WINDIR + "/System32/drivers/etc/hosts";
    let lineasEliminar = [];
    let dominiosAgregar = [];

    try {
        obtenerIPs();
        let archivoHost = fs.readFileSync(path).toString().replace(/\r/g, "").split("\n");
        config.rutas.forEach(ruta => {
            var flag = false;

            for (let i = 0; i < archivoHost.length; i++) {
                if (archivoHost[i].indexOf(ruta.dominio) >= 0) {
                    var reg = new RegExp("^" + ruta.ip.replace(".", "\\.") + "[ \t]+" + ruta.dominio.replace(".", "\\."), "g")
                    if (!reg.test(archivoHost[i])) {
                        lineasEliminar.push(i);
                    }
                    else {
                        flag = true;
                    }
                }
                else if (archivoHost[i].length === 0) {
                    lineasEliminar.push(i);
                }
            }

            if (!flag) {
                dominiosAgregar.push(ruta);
            }
        });

        if (lineasEliminar.length > 0 || dominiosAgregar.length > 0) {
            modificarArchivoHost({
                lineasEliminar: lineasEliminar,
                dominiosAgregar: dominiosAgregar,
                archivo: archivoHost
            });
        }
        else {
            ejecutar();
        }

    }
    catch (err) {
        console.error(err);
        process.exit(1);
    }
}*/

let agregarRutas = function (ips) {
    let cmd = "";

    ips.forEach(ip => {
        if (cmd.length > 0) {
            cmd += " && "
        }

        cmd += "route -p add " + ip + " " + config.server.gateway;
    });

    sudo.exec(cmd, { name: "Cliente RPV" }, (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error: ${error}`);
            process.exit(1);
        }
        else {
            ejecutar();
        }
    });
}

let verificarRutas = function () {
    let prefijoCmd = "route print -4 "
    let rutasAgregar = [];

    for (let i = 0; i < config.rutas.length; i++) {
        var ips = obtenerIPs(config.rutas[i]);

        ips.forEach(ip => {
            try {
                if (execSync(prefijoCmd + ip).toString().indexOf(ip) < 0) {
                    rutasAgregar.push(ip);
                }
            }
            catch (err) {
                console.error(err);
                process.exit(1);
            }
        });
    }

    if (rutasAgregar.length > 0) {
        agregarRutas(rutasAgregar);
    }
    else {
        ejecutar();
    }
}

let conectarVPN = function () {
    let child = execFile("./tinc/tincd.exe", ['-c', '.\\' + config.nombreVPN, '-d' + config.tincDebugLevel, '-D']);

    child.stdout.on('data', data => {
        console.log(data.toString());
    });

    child.stderr.on('data', data => {
        if(data.toString().indexOf("activated") > -1){
            ejecutar();
        }

        console.log(data.toString());
    });

    ejecutar();
}

let asignarIP = function(ip, mascara){
    let cmdCambio = 'netsh interface ipv4 set address name="' + config.nombreInterfaz + '" static ' + ip + ' ' + mascara;
    let cmdVerificar = 'netsh interface ipv4 show config name="' + config.nombreInterfaz + '"';

    try{
        let cfgInterfaz = execSync(cmdVerificar).toString();
        if(cfgInterfaz.indexOf(ip) < 0 || cfgInterfaz.indexOf(mascara) < 0 ){
            sudo.exec(cmdCambio, { name: "Cliente RPV" }, (error, stdout, stderr) => {
                if (error) {
                    console.error(`exec error: ${error}`);
                    process.exit(1);
                }
                else {
                    console.info('Conectado y listo para jugar');
                }
            });
        }
        else{
            console.info('Conectado y listo para jugar');
        }
    }
    catch(err){
        console.error(err);
        process.exit(1);
    }
}

let solicitarIP = function(){

    let options = {
        url: config.api + '/obtenerIp/' + config.cliente.id,
        method: 'GET',
        headers: {
            'Content-Type': 'application/json'
        }
    };

    request(options, function (err, res, body) {
        if (res && (res.statusCode === 200 || res.statusCode === 201)) {
            body = JSON.parse(body);
            asignarIP(body.ip.join("."), body.mascara);
        }
        else {
            console.error(body ? 'Error: ' + res.statusCode + "  " + body : 'Error: ' + res.statusCode);
            process.exit(1);
        }
    });
}

let ordenEjecucion = [
    instalarAdaptador,
    crearBase,
    crearPublicKey,
    registrarPublicKey,
    //verificarArchivoHost,
    conectarVPN,
    verificarRutas,
    solicitarIP
];

let ejecutar = function () {
    if (ordenEjecucion.length > 0) {
        let fn = ordenEjecucion.shift();
        fn();
    }
}

let verificarRequisitos = function () {

    if (verificarTapAdapter()) {
        ordenEjecucion.splice(ordenEjecucion.indexOf(instalarAdaptador), 1);
    }

    if (
        fs.existsSync("./" + config.nombreVPN) &&
        fs.existsSync("./" + config.nombreVPN + "/hosts") &&
        fs.existsSync("./" + config.nombreVPN + "/rsa_key.priv") &&
        fs.existsSync("./" + config.nombreVPN + "/hosts/" + config.cliente.id)
    ) {
        ordenEjecucion.splice(ordenEjecucion.indexOf(crearBase), 1);
    }

    if (fs.existsSync("./" + config.nombreVPN + "/rsa_key.priv")) {
        ordenEjecucion.splice(ordenEjecucion.indexOf(crearPublicKey), 1);
    }
}

verificarRequisitos();
ejecutar();
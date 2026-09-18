#include "../AlertAR-2/src/logica.h"
#include <assert.h>
#include <string.h>
#include <iostream>
#include <set>
#include <string>
using namespace alertar;
void codigo(const Carril &a, const Carril &b, const Agua &w, const char *c) {
  assert(strcmp(decidir(a,b,w).codigo,c)==0);
}
Carril medir(float h) { Carril c; c.actualizar(ALTURA_MONTAJE-h,0); return c; }
int main() {
  Agua w;
  Carril libre=medir(0), falla;
  codigo(libre,libre,w,"OK-001"); codigo(falla,libre,w,"ERR-003");
  for(float h : {5.1f, 20.f, 50.f, 75.f, 100.f}) {
    codigo(medir(h),libre,w,"INF-001");
    codigo(medir(h),medir(120),w,"INF-001");
  }
  codigo(medir(5),libre,w,"OK-001");
  codigo(medir(120),medir(120),w,"INF-001");
  Carril a=medir(120); a.actualizar(280,59999);
  codigo(a,libre,w,"INF-001"); a.actualizar(280,60000);
  codigo(a,libre,w,"ERR-006"); codigo(a,a,w,"ERR-005");
  Carril baja=medir(20); baja.actualizar(380,60000);
  codigo(baja,baja,w,"ERR-005");
  baja.actualizar(280,61000); codigo(baja,libre,w,"ERR-007");
  assert(baja.altaMs==0); baja.actualizar(280,121000);
  codigo(baja,libre,w,"ERR-006");
  a.actualizar(-1,61000); codigo(a,libre,w,"ERR-003");
  assert(a.ocupacionMs==60000); a.actualizar(280,120000);
  codigo(a,libre,w,"ERR-006");
  a.actualizar(400,121000); codigo(a,libre,w,"ERR-006");
  a.actualizar(400,123999); assert(a.ocupado);
  a.actualizar(400,124000); codigo(a,libre,w,"OK-001");
  Carril pausa=medir(120); pausa.actualizar(280,1000);
  pausa.actualizar(-1,2000); pausa.actualizar(280,90000);
  assert(pausa.ocupacionMs==1000);
  for(float d : {-1.f,0.f,1.f,400.1f,INFINITY,NAN}) {
    Carril c; c.actualizar(d,0); codigo(c,libre,w,"ERR-003");
  }
  Carril tolerancia; tolerancia.actualizar(400,0);
  assert(tolerancia.valido && tolerancia.altura==0);
  w.actualizar(2001,0); codigo(libre,libre,w,"ERR-002");
  w.actualizar(2001,19999); assert(!w.confirmada);
  w.actualizar(2001,20000); codigo(falla,falla,w,"ERR-001");
  w.actualizar(1900,21000); assert(w.confirmada && w.bruta);
  w.actualizar(1800,22000); w.actualizar(1800,41999); assert(w.confirmada);
  w.actualizar(2100,42000); w.actualizar(1800,43000);
  w.actualizar(1800,63000); assert(!w.confirmada);
  Agua wrap; wrap.actualizar(2100,UINT32_MAX-9999);
  wrap.actualizar(2100,10000); assert(wrap.confirmada);
  Carril wrapCarril; wrapCarril.actualizar(280,UINT32_MAX-9999);
  wrapCarril.actualizar(280,50000); assert(wrapCarril.persistente());
  // El rango completo incluye 2 y 400 cm; una distancia de 100 representa 3 m.
  Carril camion; camion.actualizar(100,0);
  assert(camion.altura==300 && camion.valido);
  codigo(camion,libre,w,"INF-001");
  camion.actualizar(100,59999); codigo(camion,libre,w,"INF-001");
  camion.actualizar(100,60000); codigo(camion,libre,w,"ERR-006");
  Carril extremo; extremo.actualizar(2,0); assert(extremo.valido);
  // Bajos y mixtos tampoco alertan antes de 60 s.
  for(float h : {5.1f,20.f,50.f,100.f,120.f,300.f}) {
    Carril c=medir(h), otro=medir(20);
    c.actualizar(ALTURA_MONTAJE-h,59999);
    codigo(c,libre,w,"INF-001"); codigo(c,otro,w,"INF-001");
    c.actualizar(ALTURA_MONTAJE-h,60000);
    assert(decidir(c,libre,w).color==AMARILLO);
    codigo(c,otro,w,"ERR-004");
  }
  // Dos vehículos separados no acumulan 60 s entre ambos.
  Carril sucesivos=medir(300); sucesivos.actualizar(100,59000);
  sucesivos.actualizar(400,59100); assert(!sucesivos.ocupado);
  sucesivos.actualizar(100,59200); assert(sucesivos.ocupacionMs==0);
  sucesivos.actualizar(100,118200); codigo(sucesivos,libre,w,"INF-001");
  // Barrido de combinaciones: toda salida es completa; nunca verde con agua o fallas.
  size_t casos=0; std::set<std::string> codigos;
  for(float h1 : {-10.f,0.f,5.f,5.1f,50.f,75.f,100.f,100.1f,398.f,399.f})
  for(float h2 : {-10.f,0.f,5.f,5.1f,50.f,75.f,100.f,100.1f,398.f,399.f})
  for(uint32_t t1 : {0u,59999u,60000u})
  for(uint32_t t2 : {0u,59999u,60000u})
  for(int agua=0;agua<3;++agua) {
    Carril x=medir(h1),y=medir(h2);
    x.actualizar(ALTURA_MONTAJE-h1,t1); y.actualizar(ALTURA_MONTAJE-h2,t2);
    Agua z; z.bruta=agua>0; z.confirmada=agua==2;
    Estado e=decidir(x,y,z); ++casos; codigos.insert(e.codigo);
    assert(strlen(e.codigo)>0 && strlen(e.linea1)>0);
    assert(strlen(e.linea1)<=16 && strlen(e.linea2)<=16);
    if(z.confirmada) assert(e.color==ROJO && strcmp(e.codigo,"ERR-001")==0);
    if(z.bruta || !x.valido || !y.valido) assert(e.color!=VERDE);
    if(!z.confirmada && x.valido && y.valido && x.persistente() && y.persistente())
      assert(e.color==ROJO);
    if(!z.bruta && !z.confirmada && x.valido && y.valido && !x.persistente() && !y.persistente())
      assert(e.color==VERDE);
    assert(strcmp(e.codigo,decidir(y,x,z).codigo)==0);
  }
  assert(codigos.size()==9);
  std::cout << "OK: " << casos << " combinaciones, nueve códigos, límites y secuencias temporales.\n";
}
